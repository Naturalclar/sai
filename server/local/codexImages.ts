// Codex の画像生成（`imagegen` スキル → `image_gen__imagegen`）で作った画像（#575）。
// 画像は `CODEX_HOME/generated_images/<スレッド>/exec-<item id>.png` に保存され、返答の本文にもフックの payload にもパスが
// 載らない。手がかりは rollout の `event_msg` の `item_completed` だけ（`item.type: "Extension"`・`kind: "image_gen.generation"` と、
// 見せた画像の `item.type: "ImageView"`・`path: file:///…`。codex 0.154 で実測）。
//
// **パスも中身もリクエストからは受けない**（#504 の transcript の画像と同じ線引き）: rollout は行のセッション ID から引き、
// 配るのは一覧で見つけた鍵（そのスレッドの置き場の中のファイル名）だけ。realpath がそのスレッドの置き場の中にあることを確かめ、
// 種類は中身から判定し（SVG は配らない）、IMAGE_MAX_BYTES を超えるものは配らない。rollout は大きい（手元で 10MB）ので
// **増えた分だけ**読み足す（追記しかされない）
//
// `view_image` で見せた画像（`ImageView`）は、**realpath が行の `cwd` の中にあるものも**拾う（#704。前は置き場の直下だけで、
// リポジトリの中のスクリーンショットを見せても SAI には出なかった）。鍵はパスのハッシュで、配る条件は本文の画像と同じ
// `readSessionImage()`（cwd の外・外を指すシンボリックリンク・SVG は配らない）。`/tmp` のものは一覧にも載せない
import { createHash } from 'node:crypto'
import { open, readdir, readFile, realpath, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, extname, isAbsolute, join, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { IMAGE_MAX_BYTES } from '../../shared/images.ts'
import { sniffImageType } from '../../shared/icon.ts'
import type { IconType } from '../../shared/icon.ts'
import { readSessionImage } from './images.ts'

/** 生成した画像の置き場（`CODEX_HOME/generated_images`）。CODEX_HOME の読み方は usage.ts の codexSessionsDir() と同じ */
export function codexGeneratedImagesDir(env: NodeJS.ProcessEnv = process.env, home: string = homedir()): string {
  const raw = env.CODEX_HOME?.trim()
  const codexHome = raw ? (raw === '~' ? home : raw.startsWith('~/') ? join(home, raw.slice(2)) : raw) : join(home, '.codex')
  return join(codexHome, 'generated_images')
}

export interface CodexImage {
  /** 置き場の中のファイル名（`exec-….png`）。見せた cwd の中の画像は `view-<パスのハッシュ>.<拡張子>`。配るときの鍵 */
  key: string
  /** 見せた cwd の中の画像（#704）の realpath。**サーバの中でだけ使う**（応答には載せない）。生成した画像には無い */
  file?: string
  /** rollout のその行の `timestamp`（ISO） */
  at: string
  /**
   * 作ったターンが閉じた時刻（`task_complete` / `turn_aborted` の `timestamp`）。まだ閉じていなければ空。
   * 付ける返答の行はこの時刻まで（#576 のレビュー。行を書かずに終わったターン——エラーで終わると Codex は notify を
   * 鳴らさない（#475）・止めた——の画像が、次のターンの返答に付かないように）
   */
  until: string
}

/** スレッドの ID と鍵。どちらも名前 1 つぶんだけ（`/` や `..` を含まない） */
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,200}$/
export const CODEX_IMAGE_KEY_RE = NAME_RE

interface Mention {
  /** 生成なら item id（`exec-…`。拡張子は置き場で探す）、見せた画像ならファイル名そのもの */
  id: string
  exact: boolean
  /** 置き場の外の見せた画像の絶対パス（#704）。cwd の中かは一覧を作るときに realpath で見る */
  path?: string
  at: string
  /** どのターンで作ったか（`item_completed` の `turn_id`） */
  turn: string
}

interface Scan {
  mtimeMs: number
  scanned: number
  mentions: Mention[]
  /** ターン → 閉じた時刻 */
  ends: Map<string, string>
}

/** 見せた画像として拾う拡張子（SVG は配らないので一覧にも載せない。中身は配るときにもう一度見る） */
const VIEW_EXT = /^\.(?:png|jpe?g|gif|webp)$/i

/**
 * 見せた cwd の中の画像の鍵。パスは載せない（realpath とターンのハッシュ）。**ターンごとに別の鍵にする**（#707 のレビュー）:
 * `.screenshots/` の画像は同じ名前で撮り直すので、ファイルだけで 1 つにまとめると、後のターンで見せ直しても最初のターンにしか出ない
 */
const viewKey = (real: string, turn: string) => `view-${createHash('sha256').update(`${real}\0${turn}`).digest('hex').slice(0, 16)}${extname(real).toLowerCase()}`

/**
 * rollout の 1 行から、画像への言及を取る。生成（`image_gen.generation`）は item id、
 * 見せた画像（`ImageView`）はパスがそのスレッドの置き場の直下ならファイル名、ほかの絶対パスは `path`（#704。cwd の中かはここでは見ない）
 */
export function imageMention(line: unknown, threadDir: string): Omit<Mention, 'at' | 'turn'> | null {
  const row = line as { type?: unknown; payload?: { type?: unknown; item?: Record<string, unknown> } } | null
  if (!row || row.type !== 'event_msg' || row.payload?.type !== 'item_completed') return null
  const item = row.payload.item
  if (!item || typeof item !== 'object') return null
  if (item.type === 'Extension' && item.kind === 'image_gen.generation' && item.status === 'completed' && typeof item.id === 'string' && NAME_RE.test(item.id)) {
    return { id: item.id, exact: false }
  }
  if (item.type === 'ImageView' && typeof item.path === 'string') {
    let file: string
    try {
      file = item.path.startsWith('file:') ? fileURLToPath(item.path) : item.path
    } catch {
      return null
    }
    const name = basename(file)
    if (dirname(file) === threadDir && NAME_RE.test(name)) return { id: name, exact: true }
    if (isAbsolute(file) && VIEW_EXT.test(extname(file))) return { id: '', exact: true, path: file }
  }
  return null
}

export type CodexImageRead = { ok: true; bytes: Buffer; type: IconType; name: string; etag: string } | { ok: false; status: number; reason: string }

export class CodexImages {
  private readonly root: string
  private readonly scans = new Map<string, Scan>()

  constructor(root: string = codexGeneratedImagesDir()) {
    this.root = root
  }

  /** そのスレッドの画像の置き場。ID が名前 1 つぶんでなければ空（置き場の外を指させない） */
  private threadDir(thread: string): string {
    return NAME_RE.test(thread) ? join(this.root, thread) : ''
  }

  /**
   * rollout に出てきた、そのスレッドの生成した画像と、見せた画像のうち realpath が `cwd` の中にあるもの（古い順・同じファイルは 1 回。見せた画像はターンごとに 1 回）。
   * 読めなければ空。`cwd` はセッションの行から渡す（空なら見せた画像は拾わない）
   */
  async list(rollout: string, thread: string, cwd = ''): Promise<CodexImage[]> {
    const dir = this.threadDir(thread)
    if (!rollout || !dir) return []
    let mentions: Mention[]
    let ends: Map<string, string>
    try {
      ;({ mentions, ends } = await this.scan(rollout, dir))
    } catch {
      return []
    }
    if (mentions.length === 0) return []
    // 生成した画像が 1 枚も無いスレッドには置き場が無い
    const files = await readdir(dir).then((names) => names.filter((n) => NAME_RE.test(n)), () => [] as string[])
    const root = cwd && mentions.some((m) => m.path) ? await realpath(cwd).catch(() => '') : ''
    const out: CodexImage[] = []
    const seen = new Set<string>()
    for (const m of mentions) {
      let key: string
      let file: string | undefined
      if (m.path) {
        if (!root) continue
        // 消えたファイル・cwd の外（`/tmp`、外を指すシンボリックリンク）は載せない
        file = await realpath(m.path).catch(() => '')
        if (!file || !file.startsWith(root + sep) || !VIEW_EXT.test(extname(file))) continue
        key = viewKey(file, m.turn)
      } else {
        key = m.exact ? (files.includes(m.id) ? m.id : '') : (files.find((n) => n.startsWith(`${m.id}.`)) ?? '')
      }
      if (!key || seen.has(key)) continue
      seen.add(key)
      out.push({ key, at: m.at, until: ends.get(m.turn) ?? '', ...(file ? { file } : {}) })
    }
    return out
  }

  /** 一覧で見つけた鍵の画像を読む。鍵が一覧に無ければ 404。`cwd` は一覧と同じくセッションの行から */
  async read(rollout: string, thread: string, key: string, cwd = ''): Promise<CodexImageRead> {
    if (!CODEX_IMAGE_KEY_RE.test(key)) return { ok: false, status: 400, reason: 'bad key' }
    const dir = this.threadDir(thread)
    if (!dir) return { ok: false, status: 404, reason: '置き場がありません' }
    const found = (await this.list(rollout, thread, cwd)).find((i) => i.key === key)
    if (!found) return { ok: false, status: 404, reason: 'このセッションで生成した・見せた画像ではありません' }
    // 見せた cwd の中の画像は、本文の画像と同じ条件で読む（realpath が cwd の中・リンクを辿らずに開く・中身で種類を見る）
    if (found.file) return readSessionImage({ src: found.file, cwd })
    try {
      // シンボリックリンクで置き場の外へ出ない
      const [real, realDir] = await Promise.all([realpath(join(dir, key)), realpath(dir)])
      if (!real.startsWith(realDir + sep)) return { ok: false, status: 404, reason: '置き場の外です' }
      const st = await stat(real)
      if (!st.isFile()) return { ok: false, status: 404, reason: '画像がありません' }
      if (st.size > IMAGE_MAX_BYTES) return { ok: false, status: 413, reason: `画像は ${IMAGE_MAX_BYTES / 1024 / 1024}MB までです` }
      const bytes = await readFile(real)
      const type = sniffImageType(bytes)
      if (!type) return { ok: false, status: 415, reason: '画像として読めません（PNG / JPEG / GIF / WebP）' }
      return { ok: true, bytes, type, name: key, etag: `"c${key}-${st.size}-${Math.floor(st.mtimeMs)}"` }
    } catch {
      return { ok: false, status: 404, reason: '画像が読めません' }
    }
  }

  private async scan(path: string, threadDir: string): Promise<{ mentions: Mention[]; ends: Map<string, string> }> {
    const st = await stat(path)
    let prev = this.scans.get(path)
    // 縮んだ（作り直された）ら最初から
    if (prev && st.size < prev.scanned) prev = undefined
    if (prev && st.size === prev.scanned && st.mtimeMs === prev.mtimeMs) return prev
    const from = prev?.scanned ?? 0
    const mentions = prev ? [...prev.mentions] : []
    const ends = new Map(prev?.ends ?? [])
    let scanned = from
    if (st.size > from) {
      const fh = await open(path, 'r')
      try {
        const buf = Buffer.alloc(st.size - from)
        const { bytesRead } = await fh.read(buf, 0, buf.length, from)
        const chunk = buf.subarray(0, bytesRead)
        // 書きかけの最後の行は次に回す
        const end = chunk.lastIndexOf(0x0a) + 1
        const markers = [Buffer.from('image_gen.generation'), Buffer.from('"ImageView"'), Buffer.from('"task_complete"'), Buffer.from('"turn_aborted"')]
        let start = 0
        while (start < end) {
          const nl = chunk.indexOf(0x0a, start)
          const line = chunk.subarray(start, nl)
          if (markers.some((m) => line.includes(m))) {
            try {
              const row = JSON.parse(line.toString('utf-8')) as { timestamp?: unknown; type?: unknown; payload?: { type?: unknown; turn_id?: unknown } }
              const at = typeof row.timestamp === 'string' ? row.timestamp : ''
              const turn = typeof row.payload?.turn_id === 'string' ? row.payload.turn_id : ''
              if (row.type === 'event_msg' && (row.payload?.type === 'task_complete' || row.payload?.type === 'turn_aborted')) {
                if (turn && at) ends.set(turn, at)
              } else {
                const hit = imageMention(row, threadDir)
                if (hit) mentions.push({ ...hit, at, turn })
              }
            } catch {
              // 壊れた行は飛ばす
            }
          }
          start = nl + 1
        }
        scanned = from + end
      } finally {
        await fh.close()
      }
    }
    const next = { mtimeMs: st.mtimeMs, scanned, mentions, ends }
    this.scans.set(path, next)
    return next
  }
}
