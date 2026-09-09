// 返信に添える画像。受け付け条件と、本文への足し方・取り出し方。
// サーバ（受付・保存・返信コマンドの組み立て）と画面（選んだ瞬間の検査・自分バブルのサムネイル）が同じ値を見る。
//
// 画像そのものは ~/.agent-feed/attachments/<sha1(エンティティID) の先頭16桁>/<sha1(中身) の先頭16桁>.<ext> に置く
// （server/attachments.ts）。JSONL には書かない。本文に絶対パスが載るので、記録にはパスだけが残る。

/** 1 枚の上限。スクリーンショットは数 MB になるのでアイコン（1MB）より大きく取る */
export const ATTACHMENT_MAX_BYTES = 10 * 1024 * 1024
/** 1 回の返信に添えられる枚数 */
export const ATTACHMENT_MAX_COUNT = 4

/** 保存したファイルの名前（中身のハッシュ）。パスの検査にも使う */
export const ATTACHMENT_NAME_RE = /^[0-9a-f]{16}\.(png|jpeg|gif|webp)$/
/** セッションごとのディレクトリ名（IDのハッシュ） */
export const ATTACHMENT_DIR_RE = /^[0-9a-f]{16}$/
/** 置き場のディレクトリ名（AGENT_FEED_DIR の下） */
export const ATTACHMENTS_DIR = 'attachments'

/** 本文の末尾に付ける見出し。これ以降の行が画像の絶対パス */
export const ATTACHMENT_HEADING = '添付した画像:'

/** 画面が <img src> に使う URL。中身のハッシュが名前なので、差し替わればパスごと変わる */
export function attachmentUrl(dir: string, name: string): string {
  return `/api/${ATTACHMENTS_DIR}/${dir}/${name}`
}

/**
 * 絶対パスが添付の置き場のものなら URL に。そうでなければ null。
 * 末尾 3 つ（attachments/<dir>/<name>）だけを見るので、置き場の場所を知らなくても判定できる
 */
export function attachmentUrlFromPath(path: string): string | null {
  const parts = path.split('/')
  const name = parts[parts.length - 1] ?? ''
  const dir = parts[parts.length - 2] ?? ''
  const root = parts[parts.length - 3] ?? ''
  if (root !== ATTACHMENTS_DIR || !ATTACHMENT_DIR_RE.test(dir) || !ATTACHMENT_NAME_RE.test(name)) return null
  return attachmentUrl(dir, name)
}

/**
 * 本文の末尾に画像の絶対パスを足す。Claude はこれを見て Read で読む（`claude -p` で確認済み）。
 * Codex は `-i` でも渡すが、記録に残す・自分バブルにサムネイルを出すために本文にも足す
 */
export function withAttachments(text: string, paths: readonly string[]): string {
  const body = text.trim()
  if (paths.length === 0) return body
  return `${body}\n\n${ATTACHMENT_HEADING}\n${paths.join('\n')}`.trim()
}

/**
 * withAttachments の逆。本文と、添付の URL に分ける。画面の自分バブルはパスの文字列を出さずにサムネイルにする。
 * 見出しの後ろに添付でない行が混ざっていたら、そこから先は本文に戻す（人が続きを書いた場合）
 */
export function splitAttachments(text: string): { body: string; urls: string[] } {
  const marker = `\n${ATTACHMENT_HEADING}\n`
  const at = text.lastIndexOf(marker)
  if (at < 0) return { body: text, urls: [] }
  const lines = text.slice(at + marker.length).split('\n')
  const urls: string[] = []
  for (const line of lines) {
    const url = attachmentUrlFromPath(line.trim())
    if (!url) return { body: text, urls: [] } // 添付でない行が混ざっている。触らずそのまま出す
    urls.push(url)
  }
  if (urls.length === 0) return { body: text, urls: [] }
  return { body: text.slice(0, at).trimEnd(), urls }
}
