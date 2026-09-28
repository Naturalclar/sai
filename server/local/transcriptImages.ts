// Claude の transcript に入っている画像（#504）。端末で貼った画像（`[Image #1]`）と、エージェントが Read で開いた画像は
// 記録の行には文字しか残らず、本体は transcript の `image` ブロック（base64）にしか無い。
//
// **パスも中身もリクエストからは受けない**: transcript の場所は `ProgressReader` と同じく行の cwd とセッション ID から決め、
// 画像は一覧を作るときに見つけた `(行の先頭のバイト位置, その行の何枚目か)` の鍵でだけ引く。種類は中身から判定し（SVG は配らない）、
// IMAGE_MAX_BYTES を超えるものは配らない。transcript は大きい（手元で 30MB）ので、**増えた分だけ**読み足す（追記しかされない）
import { open, stat } from 'node:fs/promises'
import { IMAGE_MAX_BYTES } from '../../shared/images.ts'
import { sniffImageType } from '../../shared/icon.ts'
import type { IconType } from '../../shared/icon.ts'

export interface TranscriptImage {
  /** `<行の先頭のバイト位置>-<その行の何枚目か>` */
  key: string
  /** その行の `timestamp`（ISO） */
  at: string
  /** 人が貼った画像か、ツールの結果（Read で開いた画像など）か */
  from: 'user' | 'agent'
}

interface Found extends TranscriptImage {
  offset: number
  length: number
  index: number
}

interface Scan {
  mtimeMs: number
  /** ここまでの完全な行を読んだ（次はここから） */
  scanned: number
  found: Found[]
}

export const TRANSCRIPT_KEY_RE = /^(\d+)-(\d+)$/

/** 1 行の中の画像ブロック（入れ子の `tool_result` の中も）を出てきた順に。人が貼ったものは user のメッセージの直下にある */
export function imageBlocks(line: unknown): { data: string; from: 'user' | 'agent' }[] {
  const out: { data: string; from: 'user' | 'agent' }[] = []
  const walk = (content: unknown, from: 'user' | 'agent') => {
    if (!Array.isArray(content)) return
    for (const b of content) {
      if (!b || typeof b !== 'object') continue
      const block = b as { type?: unknown; source?: { type?: unknown; data?: unknown }; content?: unknown }
      if (block.type === 'image' && block.source?.type === 'base64' && typeof block.source.data === 'string') out.push({ data: block.source.data, from })
      else if (block.type === 'tool_result') walk(block.content, 'agent')
    }
  }
  const row = line as { type?: unknown; message?: { content?: unknown } } | null
  if (row && row.type === 'user') walk(row.message?.content, 'user')
  return out
}

export type TranscriptImageRead = { ok: true; bytes: Buffer; type: IconType; etag: string } | { ok: false; status: number; reason: string }

export class TranscriptImages {
  private readonly scans = new Map<string, Scan>()

  /** その transcript の画像の一覧（古い順）。読めなければ空 */
  async list(path: string): Promise<TranscriptImage[]> {
    try {
      const found = await this.scan(path)
      return found.map(({ key, at, from }) => ({ key, at, from }))
    } catch {
      this.scans.delete(path)
      return []
    }
  }

  /** 一覧で見つけた鍵の画像を読む。鍵が一覧に無ければ 404 */
  async read(path: string, key: string): Promise<TranscriptImageRead> {
    if (!TRANSCRIPT_KEY_RE.test(key)) return { ok: false, status: 400, reason: 'bad key' }
    let found: Found | undefined
    try {
      found = (await this.scan(path)).find((f) => f.key === key)
    } catch {
      return { ok: false, status: 404, reason: 'transcript が読めません' }
    }
    if (!found) return { ok: false, status: 404, reason: 'この transcript に無い画像です' }
    const fh = await open(path, 'r')
    try {
      const buf = Buffer.alloc(found.length)
      await fh.read(buf, 0, found.length, found.offset)
      const block = imageBlocks(JSON.parse(buf.toString('utf-8')))[found.index]
      if (!block) return { ok: false, status: 404, reason: '画像がありません' }
      // base64 は 4 文字で 3 バイト。デコードする前に大きさを見る
      if ((block.data.length / 4) * 3 > IMAGE_MAX_BYTES) return { ok: false, status: 413, reason: `画像は ${IMAGE_MAX_BYTES / 1024 / 1024}MB までです` }
      const bytes = Buffer.from(block.data, 'base64')
      const type = sniffImageType(bytes)
      if (!type) return { ok: false, status: 415, reason: '画像として読めません（PNG / JPEG / GIF / WebP）' }
      return { ok: true, bytes, type, etag: `"t${key}"` }
    } catch {
      return { ok: false, status: 404, reason: '画像が読めません' }
    } finally {
      await fh.close()
    }
  }

  private async scan(path: string): Promise<Found[]> {
    const st = await stat(path)
    let prev = this.scans.get(path)
    // 縮んだ（作り直された）ら最初から
    if (prev && st.size < prev.scanned) prev = undefined
    if (prev && st.size === prev.scanned && st.mtimeMs === prev.mtimeMs) return prev.found
    const from = prev?.scanned ?? 0
    const found = prev ? [...prev.found] : []
    let scanned = from
    if (st.size > from) {
      const fh = await open(path, 'r')
      try {
        const buf = Buffer.alloc(st.size - from)
        const { bytesRead } = await fh.read(buf, 0, buf.length, from)
        const chunk = buf.subarray(0, bytesRead)
        // 書きかけの最後の行は次に回す
        const end = chunk.lastIndexOf(0x0a) + 1
        let start = 0
        const marker = Buffer.from('"image"')
        while (start < end) {
          const nl = chunk.indexOf(0x0a, start)
          const line = chunk.subarray(start, nl)
          if (line.includes(marker)) {
            try {
              const row = JSON.parse(line.toString('utf-8')) as { timestamp?: unknown }
              const at = typeof row.timestamp === 'string' ? row.timestamp : ''
              imageBlocks(row).forEach((b, index) => {
                const offset = from + start
                found.push({ key: `${offset}-${index}`, at, from: b.from, offset, length: line.length, index })
              })
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
    this.scans.set(path, { mtimeMs: st.mtimeMs, scanned, found })
    return found
  }
}
