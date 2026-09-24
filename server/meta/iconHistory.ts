// 今まで使ったアイコン画像の履歴（#465）。~/.agent-feed/icon-history/<sha1(中身) の先頭16桁>.<png|jpeg|gif|webp> に置く。
//
// - **中身で名前を付ける**ので、同じ画像を何度置いても 1 つにまとまる（返信の画像 `AttachmentStore` と同じ付け方）
// - **ファイルがあることが正**。icon-history.json は「最後に使った時刻」（並び順）と「取り込み済みか」だけを持つ
// - 置くのはセッションのアイコンと自分のアイコンを PUT したとき（加工したあとの PNG）。**消しても（DELETE …/icon）履歴には残す**
//   （間違えて外したものを戻せるように）。履歴から消すのは人が「履歴から消す」を押したときだけ
// - 初めて使うときに、いまの session-icons/ の中身を取り込む（取り込まないと、今まで付けた分が 1 つも出ない）。
//   **取り込んだことは json に覚える**ので、履歴から消したものが次の起動で戻ってくることはない
// - 鍵はリクエストから受けるが、`^[0-9a-f]{16}$` の形だけを通し、パスは組み立てた置き場の中だけ
import { createHash } from 'node:crypto'
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { ICON_MIME, sniffImageType, type IconType } from '../../shared/icon.ts'
import type { IconStore } from './icons.ts'

export const ICON_HISTORY_DIR = 'icon-history'
export const ICON_HISTORY_FILE = 'icon-history.json'

const KEY_RE = /^[0-9a-f]{16}$/
const TYPES = Object.keys(ICON_MIME) as IconType[]

/** 画像の中身 → 履歴の鍵 */
export function historyKey(bytes: Uint8Array): string {
  return createHash('sha1').update(bytes).digest('hex').slice(0, 16)
}

/** 鍵として受け付ける形か（リクエストから来た値をパスに使う前に必ず通す） */
export function isHistoryKey(key: string): boolean {
  return KEY_RE.test(key)
}

export interface HistoryEntry {
  key: string
  type: IconType
  mime: string
  path: string
  /** 最後に使った時刻（ISO）。json に無ければファイルの mtime */
  used_at: string
  /** 差し替え検知（URL の ?v=）。中身で名前が決まるので、実際には変わらない */
  version: string
}

interface State {
  seeded: boolean
  used: Record<string, string>
}

export class IconHistory {
  readonly dir: string
  readonly file: string
  private readonly icons: IconStore
  /** 書き込みを 1 本ずつにする（同じ json を 2 つの PUT が同時に書き換えない） */
  private chain: Promise<unknown> = Promise.resolve()

  constructor(dir: string, file: string, icons: IconStore) {
    this.dir = dir
    this.file = file
    this.icons = icons
  }

  /** 新しく使った順。取り込みがまだなら先に取り込む */
  async list(): Promise<HistoryEntry[]> {
    await this.seed()
    const state = await this.state()
    const out: HistoryEntry[] = []
    let names: string[]
    try {
      names = await readdir(this.dir)
    } catch {
      return []
    }
    for (const name of names) {
      const m = name.match(/^([0-9a-f]{16})\.(png|jpeg|gif|webp)$/)
      if (!m) continue
      const key = m[1]!
      const type = m[2] as IconType
      const path = join(this.dir, name)
      try {
        const st = await stat(path)
        if (!st.isFile()) continue
        out.push({ key, type, mime: ICON_MIME[type], path, used_at: state.used[key] ?? new Date(st.mtimeMs).toISOString(), version: String(st.mtimeMs) })
      } catch {
        // 一覧を取った直後に消えた
      }
    }
    return out.sort((a, b) => (a.used_at < b.used_at ? 1 : a.used_at > b.used_at ? -1 : a.key < b.key ? -1 : 1))
  }

  async get(key: string): Promise<HistoryEntry | undefined> {
    if (!isHistoryKey(key)) return undefined
    return (await this.list()).find((e) => e.key === key)
  }

  /** 中身を読む。無ければ null */
  async read(key: string): Promise<Uint8Array | null> {
    const entry = await this.get(key)
    if (!entry) return null
    try {
      return await readFile(entry.path)
    } catch {
      return null
    }
  }

  /** 置く（あれば「使った時刻」を今にするだけ）。画像でなければ空の鍵 */
  async add(bytes: Uint8Array, at = new Date()): Promise<string> {
    await this.seed()
    return this.serial(() => this.write(bytes, at.toISOString()))
  }

  /** 履歴から消す。いま使っているセッションのアイコン（session-icons/ の別のコピー）は消えない */
  async remove(key: string): Promise<boolean> {
    if (!isHistoryKey(key)) return false
    return this.serial(async () => {
      let found = false
      for (const type of TYPES) {
        const path = join(this.dir, `${key}.${type}`)
        try {
          await stat(path)
          found = true
        } catch {
          continue
        }
        await rm(path, { force: true })
      }
      const state = await this.state()
      delete state.used[key]
      await this.save(state)
      return found
    })
  }

  /** いまの session-icons/ の中身を取り込む。1 度だけ（json に覚える） */
  private async seed(): Promise<void> {
    if ((await this.state()).seeded) return
    await this.serial(async () => {
      const state = await this.state()
      if (state.seeded) return
      const { entries } = await this.icons.all()
      for (const icon of entries.values()) {
        let bytes: Uint8Array
        try {
          bytes = await readFile(icon.path)
        } catch {
          continue
        }
        // 使った時刻は置いたときの mtime（新しく付けたものほど上に来る）
        await this.write(bytes, new Date(Number(icon.version) || Date.now()).toISOString(), true)
      }
      const next = await this.state()
      next.seeded = true
      await this.save(next)
    })
  }

  /** 1 件書く（serial の中から呼ぶ）。`keepNewer` なら、すでにもっと新しい時刻があるときは上書きしない */
  private async write(bytes: Uint8Array, usedAt: string, keepNewer = false): Promise<string> {
    const type = sniffImageType(bytes)
    if (!type) return ''
    const key = historyKey(bytes)
    const target = join(this.dir, `${key}.${type}`)
    await mkdir(this.dir, { recursive: true })
    try {
      await stat(target)
    } catch {
      const tmp = `${target}.${process.pid}.tmp`
      await writeFile(tmp, bytes)
      await rename(tmp, target)
    }
    const state = await this.state()
    const prev = state.used[key]
    if (!(keepNewer && prev && prev > usedAt)) state.used[key] = usedAt
    await this.save(state)
    return key
  }

  private async state(): Promise<State> {
    try {
      const raw = JSON.parse(await readFile(this.file, 'utf-8')) as unknown
      if (!raw || typeof raw !== 'object') throw new Error('bad')
      const o = raw as { seeded?: unknown; used?: unknown }
      const used: Record<string, string> = {}
      if (o.used && typeof o.used === 'object') {
        for (const [k, v] of Object.entries(o.used as Record<string, unknown>)) if (isHistoryKey(k) && typeof v === 'string') used[k] = v
      }
      return { seeded: o.seeded === true, used }
    } catch {
      return { seeded: false, used: {} }
    }
  }

  private async save(state: State): Promise<void> {
    await mkdir(join(this.file, '..'), { recursive: true })
    const tmp = `${this.file}.${process.pid}.tmp`
    await writeFile(tmp, `${JSON.stringify({ seeded: state.seeded, used: state.used }, null, 2)}\n`)
    await rename(tmp, this.file)
  }

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.chain.then(fn, fn)
    this.chain = next.catch(() => {})
    return next
  }
}
