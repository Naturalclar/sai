// 返信に添える画像とファイル（#608。文字のファイルと PDF）。受け付け条件と、本文への足し方・取り出し方。
// サーバ（受付・保存・返信コマンドの組み立て）と画面（選んだ瞬間の検査・自分バブルのサムネイル）が同じ値を見る。
//
// 画像そのものは ~/.agent-feed/attachments/<sha1(エンティティID) の先頭16桁>/<sha1(中身) の先頭16桁>.<ext> に置く
// （server/reply/attachments.ts）。JSONL には書かない。本文に絶対パスが載るので、記録にはパスだけが残る。

/** 1 枚の上限。スクリーンショットは数 MB になるのでアイコン（1MB）より大きく取る */
export const ATTACHMENT_MAX_BYTES = 10 * 1024 * 1024
/** 1 回の返信に添えられる枚数 */
export const ATTACHMENT_MAX_COUNT = 4

/** 保存した**画像**の名前（中身のハッシュ）。パスの検査と、配る口（画像だけを配る）に使う */
export const ATTACHMENT_NAME_RE = /^[0-9a-f]{16}\.(png|jpeg|gif|webp)$/
/**
 * 保存した**画像以外のファイル**の名前（#608）。文字のファイルは元の拡張子に関わらず `.txt`、PDF は `.pdf`
 * （HTML や SVG も `.txt` で置く。**配る口はこの名前を通さない**ので、同じオリジンで描かれることは無い）
 */
export const ATTACHMENT_FILE_NAME_RE = /^[0-9a-f]{16}\.(txt|pdf)$/
/** セッションごとのディレクトリ名（IDのハッシュ） */
export const ATTACHMENT_DIR_RE = /^[0-9a-f]{16}$/
/** 置き場のディレクトリ名（AGENT_FEED_DIR の下） */
export const ATTACHMENTS_DIR = 'attachments'

/** 本文の末尾に付ける見出し。これ以降の行が画像の絶対パス */
export const ATTACHMENT_HEADING = '添付した画像:'
/** 画像以外のファイルの見出し（#608）。これ以降の行が `<絶対パス>（<元の名前>）` */
export const ATTACHMENT_FILE_HEADING = '添付したファイル:'

/** 中身から決めた種類。`image` は PNG / JPEG / GIF / WebP、`text` は UTF-8 として読める文字のファイル */
export type AttachmentKind = 'image' | 'text' | 'pdf'

/** 文字のファイルに出てこない制御文字（NUL など）。タブ・改行・復帰・改ページ・ESC（色付きのログ）は通す */
const isBinaryByte = (b: number) => b < 0x09 || (b > 0x0d && b < 0x1b) || (b > 0x1b && b < 0x20)

/** `%PDF-` で始まるか */
export function sniffPdf(bytes: Uint8Array): boolean {
  return bytes.length >= 5 && bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46 && bytes[4] === 0x2d
}

/** 文字のファイルに出てこないバイトが混ざっているか（画面は頭だけ、サーバは全部を見る） */
export function hasBinaryBytes(bytes: Uint8Array): boolean {
  for (const b of bytes) if (isBinaryByte(b)) return true
  return false
}

/**
 * 全部の中身が、文字のファイル（UTF-8）として読めるか。空・制御文字入り・UTF-8 として壊れているものは false。
 * **拡張子は見ない**（`.txt` と名乗るバイナリを通さない・拡張子の無いログを通す）
 */
export function isUtf8Text(bytes: Uint8Array): boolean {
  if (bytes.length === 0 || hasBinaryBytes(bytes)) return false
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    return true
  } catch {
    return false
  }
}

/** 画面に出す元の名前の上限 */
export const ATTACHMENT_LABEL_MAX = 80

/**
 * 元のファイル名を、画面に出す・本文の行に添える形にする（#608）。**パスには使わない**。
 * ディレクトリの部分・制御文字・改行・全角の括弧（行の区切りに使う）を落として切る。何も残らなければ空
 */
export function attachmentLabel(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? ''
  // eslint-disable-next-line no-control-regex
  const clean = base.replace(/[\u0000-\u001f\u007f（）]/g, '').trim()
  return Array.from(clean).slice(0, ATTACHMENT_LABEL_MAX).join('')
}

/** `12 KB` / `3.4 MB`。画面の添付の並びに出す大きさ */
export function fileSizeLabel(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return ''
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

/** バブルに出す、画像以外の添付 1 つ */
export interface AttachedFile {
  /** 置き場の名前（`<ハッシュ>.txt`）。並びの鍵にするだけで、開くリンクにはしない（配る口が無い） */
  key: string
  /** 元の名前。無ければ空 */
  name: string
  kind: 'text' | 'pdf'
}

/** 絶対パスが添付の置き場の**画像**か（末尾 3 つで見る）。Codex の `-i` など、画像だけを受ける口に渡す前に通す */
export function isImageAttachmentPath(path: string): boolean {
  return attachmentUrlFromPath(path) !== null
}

/** 絶対パスが添付の置き場の**画像以外のファイル**か */
export function isFileAttachmentPath(path: string): boolean {
  const parts = path.split('/')
  return parts[parts.length - 3] === ATTACHMENTS_DIR && ATTACHMENT_DIR_RE.test(parts[parts.length - 2] ?? '') && ATTACHMENT_FILE_NAME_RE.test(parts[parts.length - 1] ?? '')
}

const FILE_LINE_RE = /^(.+?)(?:（([^（）]*)）)?$/

function parseFileLine(line: string): AttachedFile | null {
  const m = FILE_LINE_RE.exec(line.trim())
  const path = m?.[1] ?? ''
  if (!isFileAttachmentPath(path)) return null
  const key = path.slice(path.lastIndexOf('/') + 1)
  return { key, name: m?.[2] ?? '', kind: key.endsWith('.pdf') ? 'pdf' : 'text' }
}

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
 * 本文の末尾に添付の絶対パスを足す。Claude はこれを見て Read で読む（`claude -p` で確認済み）。
 * Codex は画像を `-i` でも渡すが、記録に残す・自分バブルにサムネイルを出すために本文にも足す。
 * **画像と、それ以外のファイル（#608）は見出しを分ける**（画像の見出しは前のまま）。`names` は画像以外の元の名前（パス → 名前）
 */
export function withAttachments(text: string, paths: readonly string[], names: ReadonlyMap<string, string> = new Map()): string {
  const body = text.trim()
  if (paths.length === 0) return body
  const images = paths.filter((p) => !isFileAttachmentPath(p))
  const files = paths.filter(isFileAttachmentPath).map((p) => {
    const label = attachmentLabel(names.get(p) ?? '')
    return label ? `${p}（${label}）` : p
  })
  const blocks = [body, images.length > 0 ? `${ATTACHMENT_HEADING}\n${images.join('\n')}` : '', files.length > 0 ? `${ATTACHMENT_FILE_HEADING}\n${files.join('\n')}` : '']
  return blocks.filter(Boolean).join('\n\n').trim()
}

/** 末尾の「見出し + 行」の塊を 1 つ外す。行がどれか 1 つでも読めなければ外さない（人が続きを書いた場合） */
function takeBlock<T>(text: string, heading: string, parse: (line: string) => T | null): { rest: string; items: T[] } {
  // 本文が空で添付だけのときは見出しが頭に来る
  const padded = `\n${text}`
  const marker = `\n${heading}\n`
  const at = padded.lastIndexOf(marker)
  if (at < 0) return { rest: text, items: [] }
  const items: T[] = []
  for (const line of padded.slice(at + marker.length).split('\n')) {
    const item = parse(line)
    if (!item) return { rest: text, items: [] }
    items.push(item)
  }
  if (items.length === 0) return { rest: text, items: [] }
  return { rest: padded.slice(1, Math.max(1, at)).trimEnd(), items }
}

/**
 * withAttachments の逆。本文と、画像の URL と、画像以外のファイルに分ける。画面の自分バブルはパスの文字列を出さずに
 * サムネイルと名前にする。見出しの後ろに添付でない行が混ざっていたら、そこから先は本文に戻す（人が続きを書いた場合）
 */
export function splitAttachments(text: string): { body: string; urls: string[]; files: AttachedFile[] } {
  const files = takeBlock(text, ATTACHMENT_FILE_HEADING, parseFileLine)
  const images = takeBlock(files.rest, ATTACHMENT_HEADING, (line) => attachmentUrlFromPath(line.trim()))
  return { body: images.rest, urls: images.items, files: files.items }
}
