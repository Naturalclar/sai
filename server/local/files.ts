// 返答に出てきた手元のファイルを配る（#603。GET /api/sessions/<id>/files/<key>）。画像（images.ts。#321）と同じ作り:
// **パスはリクエストから受けない**。そのセッションのターン完了の行の本文から参照を拾って「鍵 → パス」の表を作り（fileTable）、
// 鍵で引けたものだけを読む。読むのは次を全部満たすものだけ:
//   - 名前で断る一覧（shared/files.ts の isSecretPath()。`.env*`・`*.pem`・`id_*`・`.git/` など）に当たらない。
//     **書かれたパスと、リンクを解いた先の両方**で見る（`notes.md` → `.env` のリンクを読ませない）
//   - realpath が行の cwd（の realpath）の中。シンボリックリンクや `../` で外に出ない
//   - FILE_MAX_BYTES 以下
//   - 中身が文字（UTF-8 として読め、NUL を含まない）。拡張子は信じない
// 返すのは文字だけで、画面も文字として見せる（HTML を描かない。同じオリジンでスクリプトが動くため）。
// **出す相手（当面ループバックだけ）は呼ぶ側の app.ts が決める。**
import { constants } from 'node:fs'
import { open, realpath } from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import type { FeedRow } from '../../shared/types.ts'
import { eventKind } from '../../shared/events.ts'
import { FILE_MAX_BYTES, fileKey, fileRefs, isSecretPath } from '../../shared/files.ts'
import { imageName } from '../../shared/markdown.ts'

export interface FileSource {
  /** 本文に書かれたパスそのもの（行の指定は外したもの） */
  src: string
  /** そのパスが書かれた行の cwd。相対パスはここから解決し、ここの外は配らない */
  cwd: string
}

/**
 * そのセッションの行から「鍵 → ファイルの参照」の表を作る。見るのは**ターン完了の行の本文（`text`）の `` `コード` ``** だけ
 * （自分の入力・待ちの行の要約・`thinking` は見ない）。同じパスが何度も出てきたら新しい行の cwd を使う
 */
export function fileTable(rows: FeedRow[], fallbackCwd = ''): Map<string, FileSource> {
  const table = new Map<string, FileSource>()
  for (const r of rows) {
    if (eventKind(r.event, r.text) !== 'turn' || !r.text) continue
    const cwd = r.cwd || fallbackCwd
    for (const src of fileRefs(r.text)) table.set(fileKey(src), { src, cwd })
  }
  return table
}

/**
 * `Host` がループバックの名前か（`127.0.0.1` / `localhost` / `[::1]`。ポートは問わない）。
 * **DNS の付け替え（rebinding）への備え**: ソケットがループバックでも、外のページが自分のホスト名を 127.0.0.1 に向け直すと
 * 「同じオリジンの GET」として読めてしまう。そのときブラウザが送る `Host` は外の名前なので、ここで断る
 */
export function isLoopbackHostHeader(host: string | undefined): boolean {
  if (!host) return false
  const name = host.trim().toLowerCase().replace(/:\d+$/, '')
  return name === '127.0.0.1' || name === 'localhost' || name === '[::1]'
}

export type FileRead =
  | { ok: true; text: string; bytes: number; name: string; path: string }
  | { ok: false; status: number; reason: string }

const fail = (status: number, reason: string): FileRead => ({ ok: false, status, reason })
const inside = (root: string, path: string) => path.startsWith(root.endsWith(sep) ? root : root + sep)
const SECRET = 'この名前のファイルは SAI では開きません（鍵や認証の設定が入っていることがあるため）'

/** 中身を文字として読む。UTF-8 として読めない・NUL を含む（バイナリ）なら null */
export function decodeText(bytes: Buffer): string | null {
  if (bytes.includes(0)) return null
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    return null
  }
}

/** 表で引けた参照を読む。条件に合わなければ理由と HTTP の状態を返す（**中身は返さない**） */
export async function readSessionFile(source: FileSource, max = FILE_MAX_BYTES): Promise<FileRead> {
  if (!source.cwd) return fail(404, '作業ディレクトリが分からないので読めません')
  if (isSecretPath(source.src)) return fail(403, SECRET)
  let root: string
  try {
    root = await realpath(source.cwd)
  } catch {
    return fail(404, '作業ディレクトリがありません')
  }
  const written = source.src.startsWith('~/') ? resolve(homedir(), source.src.slice(2)) : source.src
  const absolute = isAbsolute(written)
  let real: string
  try {
    real = await realpath(absolute ? written : resolve(source.cwd, written))
  } catch {
    // 名前だけ書かれたファイル（`record.py`）は、下の階層にあっても見つからない
    return fail(404, absolute ? 'ファイルがありません' : 'ファイルがありません（作業ディレクトリからの相対パスで探しました）')
  }
  if (!inside(root, real)) return fail(403, '作業ディレクトリの外のファイルは開きません')
  // リンクを解いた先の名前でも断る
  if (isSecretPath(relative(root, real))) return fail(403, SECRET)
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
    const tooBig = fail(413, `大きすぎるので開きません（${Math.round(max / 1024)}KB まで）`)
    if (st.size > max) return tooBig
    const bytes = await fh.readFile()
    if (bytes.length > max) return tooBig
    const text = decodeText(bytes)
    if (text === null) return fail(415, '文字のファイルではないので開きません')
    return { ok: true, text, bytes: bytes.length, name: imageName(source.src), path: source.src }
  } finally {
    await fh.close()
  }
}
