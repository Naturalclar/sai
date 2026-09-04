// セッションごとのアイコン画像。~/.agent-feed/session-icons/<sha1(ID) の先頭16桁>.<png|jpeg|gif|webp> に置く。
// エンティティ ID には `@` や `/` が入るのでファイル名には使わず、ID からパスを組み立てない。
// session-meta.json には書かない（ファイルの有無が正）。ディレクトリを (mtime) で覚えて変わらなければ読み直さない
import { createHash } from 'node:crypto'
import { mkdir, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { ICON_MIME, sniffImageType, type IconType } from '../shared/icon.ts'

export const ICONS_DIR = 'session-icons'

export interface IconInfo {
  /** ファイルの絶対パス */
  path: string
  type: IconType
  mime: string
  /** 差し替え検知（URL の ?v= と rev に使う） */
  version: string
  size: number
}

interface Cached {
  mtimeMs: number
  entries: Map<string, IconInfo>
}

const TYPES = Object.keys(ICON_MIME) as IconType[]

/** ID → ファイル名の幹。逆引きはしない（一覧は ID を持っているので、ID から引ければ足りる） */
export function iconKey(id: string): string {
  return createHash('sha1').update(id).digest('hex').slice(0, 16)
}

export class IconStore {
  readonly dir: string
  private cache: Cached | null = null

  constructor(dir: string) {
    this.dir = dir
  }

  /**
   * 全部（キーはファイル名の幹）。ディレクトリが無ければ空。
   * rev は中身（名前・mtime・サイズ）のハッシュで、どれか1つ差し替えても変わる。空なら ''
   */
  async all(): Promise<{ rev: string; entries: Map<string, IconInfo> }> {
    let st
    try {
      st = await stat(this.dir)
    } catch {
      this.cache = null
      return { rev: '', entries: new Map() }
    }
    if (!this.cache || this.cache.mtimeMs !== st.mtimeMs) {
      const entries = new Map<string, IconInfo>()
      for (const name of await readdir(this.dir)) {
        const m = name.match(/^([0-9a-f]{16})\.(png|jpeg|gif|webp)$/)
        if (!m) continue
        const type = m[2] as IconType
        try {
          const fst = await stat(join(this.dir, name))
          if (!fst.isFile()) continue
          entries.set(m[1]!, { path: join(this.dir, name), type, mime: ICON_MIME[type], version: String(fst.mtimeMs), size: fst.size })
        } catch {
          // 一覧を取った直後に消えた。無いものとして扱う
        }
      }
      this.cache = { mtimeMs: st.mtimeMs, entries }
    }
    const { entries } = this.cache
    if (entries.size === 0) return { rev: '', entries }
    const h = createHash('sha1')
    for (const key of [...entries.keys()].sort()) {
      const e = entries.get(key)!
      h.update(`${key}.${e.type}:${e.version}:${e.size}\n`)
    }
    return { rev: h.digest('hex').slice(0, 12), entries }
  }

  async get(id: string): Promise<IconInfo | undefined> {
    return (await this.all()).entries.get(iconKey(id))
  }

  /**
   * 置く。中身で種類を見て、画像でなければ error。同じ ID の別の種類のファイルは消す（PNG → JPEG に差し替えたとき）。
   * tmp に書いて rename するので、途中で落ちても壊れたファイルは残らない
   */
  async put(id: string, bytes: Uint8Array): Promise<{ icon: IconInfo | null; error: string }> {
    const type = sniffImageType(bytes)
    if (!type) return { icon: null, error: '画像ファイル（PNG / JPEG / GIF / WebP）を選んでください' }
    const key = iconKey(id)
    await mkdir(this.dir, { recursive: true })
    const target = join(this.dir, `${key}.${type}`)
    const tmp = `${target}.${process.pid}.tmp`
    await writeFile(tmp, bytes)
    await rename(tmp, target)
    for (const other of TYPES) if (other !== type) await rm(join(this.dir, `${key}.${other}`), { force: true })
    this.cache = null
    return { icon: (await this.get(id)) ?? null, error: '' }
  }

  /** 消す。無くても失敗しない */
  async remove(id: string): Promise<void> {
    const key = iconKey(id)
    for (const type of TYPES) await rm(join(this.dir, `${key}.${type}`), { force: true })
    this.cache = null
  }
}
