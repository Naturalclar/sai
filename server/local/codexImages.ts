// Codex の画像生成（`imagegen` スキル → `image_gen__imagegen`）で作った画像（#575）。
// 画像は `CODEX_HOME/generated_images/<スレッド>/exec-<item id>.png` に保存され、返答の本文にもフックの payload にもパスが
// 載らない。手がかりは rollout の `event_msg` の `item_completed` だけ（`item.type: "Extension"`・`kind: "image_gen.generation"` と、
// 見せた画像の `item.type: "ImageView"`・`path: file:///…`。codex 0.154 で実測）。
//
// **パスも中身もリクエストからは受けない**（#504 の transcript の画像と同じ線引き）: rollout は行のセッション ID から引き、
// 配るのは一覧で見つけた鍵（そのスレッドの置き場の中のファイル名）だけ。realpath がそのスレッドの置き場の中にあることを確かめ、
// 種類は中身から判定し（SVG は配らない）、IMAGE_MAX_BYTES を超えるものは配らない。rollout は大きい（手元で 10MB）ので
// **増えた分だけ**読み足す（追記しかされない）
import { open, readdir, readFile, realpath, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, join, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { IMAGE_MAX_BYTES } from '../../shared/images.ts'
import { sniffImageType } from '../../shared/icon.ts'
import type { IconType } from '../../shared/icon.ts'

/** 生成した画像の置き場（`CODEX_HOME/generated_images`）。CODEX_HOME の読み方は usage.ts の codexSessionsDir() と同じ */
export function codexGeneratedImagesDir(env: NodeJS.ProcessEnv = process.env, home: string = homedir()): string {
  const raw = env.CODEX_HOME?.trim()
  const codexHome = raw ? (raw === '~' ? home : raw.startsWith('~/') ? join(home, raw.slice(2)) : raw) : join(home, '.codex')
  return join(codexHome, 'generated_images')
}

export interface CodexImage {
  /** 置き場の中のファイル名（`exec-….png`）。配るときの鍵 */
  key: string
  /** rollout のその行の `timestamp`（ISO） */
  at: string
}

/** スレッドの ID と鍵。どちらも名前 1 つぶんだけ（`/` や `..` を含まない） */
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,200}$/
export const CODEX_IMAGE_KEY_RE = NAME_RE

interface Mention {
  /** 生成なら item id（`exec-…`。拡張子は置き場で探す）、見せた画像ならファイル名そのもの */
  id: string
  exact: boolean
  at: string
}

interface Scan {
  mtimeMs: number
  scanned: number
  mentions: Mention[]
}

/**
 * rollout の 1 行から、そのスレッドの置き場の画像への言及を取る。生成（`image_gen.generation`）は item id、
 * 見せた画像（`ImageView`）はパスがそのスレッドの置き場の直下のときだけファイル名
 */
export function imageMention(line: unknown, threadDir: string): Omit<Mention, 'at'> | null {
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

  /** rollout に出てきた、そのスレッドの生成した画像（古い順・同じファイルは 1 回）。読めなければ空 */
  async list(rollout: string, thread: string): Promise<CodexImage[]> {
    const dir = this.threadDir(thread)
    if (!rollout || !dir) return []
    let mentions: Mention[]
    let files: string[]
    try {
      mentions = await this.scan(rollout, dir)
      if (mentions.length === 0) return []
      files = (await readdir(dir)).filter((n) => NAME_RE.test(n))
    } catch {
      return []
    }
    const out: CodexImage[] = []
    const seen = new Set<string>()
    for (const m of mentions) {
      const key = m.exact ? (files.includes(m.id) ? m.id : '') : (files.find((n) => n.startsWith(`${m.id}.`)) ?? '')
      if (!key || seen.has(key)) continue
      seen.add(key)
      out.push({ key, at: m.at })
    }
    return out
  }

  /** 一覧で見つけた鍵の画像を読む。鍵が一覧に無ければ 404 */
  async read(rollout: string, thread: string, key: string): Promise<CodexImageRead> {
    if (!CODEX_IMAGE_KEY_RE.test(key)) return { ok: false, status: 400, reason: 'bad key' }
    const dir = this.threadDir(thread)
    if (!dir) return { ok: false, status: 404, reason: '置き場がありません' }
    if (!(await this.list(rollout, thread)).some((i) => i.key === key)) return { ok: false, status: 404, reason: 'このセッションで生成した画像ではありません' }
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

  private async scan(path: string, threadDir: string): Promise<Mention[]> {
    const st = await stat(path)
    let prev = this.scans.get(path)
    // 縮んだ（作り直された）ら最初から
    if (prev && st.size < prev.scanned) prev = undefined
    if (prev && st.size === prev.scanned && st.mtimeMs === prev.mtimeMs) return prev.mentions
    const from = prev?.scanned ?? 0
    const mentions = prev ? [...prev.mentions] : []
    let scanned = from
    if (st.size > from) {
      const fh = await open(path, 'r')
      try {
        const buf = Buffer.alloc(st.size - from)
        const { bytesRead } = await fh.read(buf, 0, buf.length, from)
        const chunk = buf.subarray(0, bytesRead)
        // 書きかけの最後の行は次に回す
        const end = chunk.lastIndexOf(0x0a) + 1
        const markers = [Buffer.from('image_gen.generation'), Buffer.from('"ImageView"')]
        let start = 0
        while (start < end) {
          const nl = chunk.indexOf(0x0a, start)
          const line = chunk.subarray(start, nl)
          if (markers.some((m) => line.includes(m))) {
            try {
              const row = JSON.parse(line.toString('utf-8')) as { timestamp?: unknown }
              const hit = imageMention(row, threadDir)
              if (hit) mentions.push({ ...hit, at: typeof row.timestamp === 'string' ? row.timestamp : '' })
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
    this.scans.set(path, { mtimeMs: st.mtimeMs, scanned, mentions })
    return mentions
  }
}
