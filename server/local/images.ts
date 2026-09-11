// 返答の本文にある手元の画像を配る（#321。GET /api/sessions/<id>/images/<key>）。
// **パスはリクエストから受けない**: そのセッションのターン完了の行の本文から参照を拾って「鍵 → パス」の表を作り（imageTable）、
// 鍵で引けたものだけを読む（permissions.ts / diff.ts / progress.ts と同じ考え方）。読むのは次を全部満たすものだけ:
//   - realpath が行の cwd（の realpath）の中。シンボリックリンクや `../` で外に出ない
//   - 中身が PNG / JPEG / GIF / WebP（拡張子は信じない。SVG は同じオリジンで開くとスクリプトが動くので配らない）
//   - IMAGE_MAX_BYTES 以下
import { constants } from 'node:fs'
import { open, realpath } from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import { isAbsolute, resolve, sep } from 'node:path'
import type { FeedRow } from '../../shared/types.ts'
import { eventKind } from '../../shared/events.ts'
import { imageName } from '../../shared/markdown.ts'
import { IMAGE_MAX_BYTES, imageKey, imageRefs } from '../../shared/images.ts'
import { ICON_MIME, sniffImageType } from '../../shared/icon.ts'
import type { IconType } from '../../shared/icon.ts'

export interface ImageSource {
  /** 本文に書かれたパスそのもの */
  src: string
  /** そのパスが書かれた行の cwd。相対パスはここから解決し、ここの外は配らない */
  cwd: string
}

/**
 * そのセッションの行から「鍵 → 画像の参照」の表を作る。見るのは**ターン完了の行の本文（`text`）だけ**
 * （待ちの行の要約や自分の入力に書いたパスは配らない）。同じパスが何度も出てきたら新しい行の cwd を使う
 */
export function imageTable(rows: FeedRow[], fallbackCwd = ''): Map<string, ImageSource> {
  const table = new Map<string, ImageSource>()
  for (const r of rows) {
    if (eventKind(r.event) !== 'turn' || !r.text) continue
    for (const { src } of imageRefs(r.text)) table.set(imageKey(src), { src, cwd: r.cwd || fallbackCwd })
  }
  return table
}

export type ImageRead =
  | { ok: true; bytes: Buffer; type: IconType; name: string; etag: string }
  | { ok: false; status: number; reason: string }

const fail = (status: number, reason: string): ImageRead => ({ ok: false, status, reason })

/** `root` の中か（root そのものは画像ではないので、中身だけ） */
const inside = (root: string, path: string) => path.startsWith(root.endsWith(sep) ? root : root + sep)

/** 表で引けた参照を読む。条件に合わなければ理由と HTTP の状態を返す */
export async function readSessionImage(source: ImageSource, max = IMAGE_MAX_BYTES): Promise<ImageRead> {
  if (!source.cwd) return fail(404, '作業ディレクトリが分からないので読めません')
  let root: string
  try {
    root = await realpath(source.cwd)
  } catch {
    return fail(404, '作業ディレクトリがありません')
  }
  let real: string
  try {
    real = await realpath(isAbsolute(source.src) ? source.src : resolve(source.cwd, source.src))
  } catch {
    return fail(404, 'ファイルがありません')
  }
  if (!inside(root, real)) return fail(403, '作業ディレクトリの外のファイルは配りません')
  let fh: FileHandle
  try {
    // realpath で確かめたあとに差し替えられたシンボリックリンクは開かない
    fh = await open(real, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  } catch {
    return fail(404, 'ファイルを開けません')
  }
  try {
    const st = await fh.stat()
    if (!st.isFile()) return fail(404, 'ファイルではありません')
    const tooBig = fail(413, `画像は ${max / 1024 / 1024}MB までです`)
    if (st.size > max) return tooBig
    const bytes = await fh.readFile()
    if (bytes.length > max) return tooBig
    const type = sniffImageType(bytes)
    if (!type) return fail(415, '画像として読めません（PNG / JPEG / GIF / WebP）')
    return { ok: true, bytes, type, name: imageName(source.src), etag: `"${st.size.toString(16)}-${Math.floor(st.mtimeMs).toString(16)}"` }
  } finally {
    await fh.close()
  }
}

/** ダウンロードの名前。ASCII でない文字と `"` `\` は filename で `_` にし、filename* に UTF-8 で本来の名前を載せる */
export function contentDisposition(name: string): string {
  const ascii = name.replace(/[^\x20-\x7e]|["\\]/g, '_')
  const encoded = encodeURIComponent(name).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`
}

/** 配るときのヘッダ。同じパスで作り直されることがあるので毎回確かめさせ（ETag が同じなら 304）、中身の推測と実行はさせない */
export function imageHeaders(img: { bytes: Buffer; type: IconType; name: string; etag: string }, download: boolean): Record<string, string | number> {
  return {
    'Content-Type': ICON_MIME[img.type],
    'Content-Length': img.bytes.length,
    'Cache-Control': 'private, no-cache',
    ETag: img.etag,
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'none'; sandbox",
    ...(download ? { 'Content-Disposition': contentDisposition(img.name) } : {}),
  }
}
