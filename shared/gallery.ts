// セッションに出てきた画像の一覧（#504）。セッション画面の会話の下に並べて、見返せるようにする。
// ここは行から組み立てる部分だけ（純粋関数）。Claude の transcript に入っている画像（端末で貼った `[Image #N]`、
// エージェントが Read で開いたもの）は server/local/transcriptImages.ts が足す。
//
// 拾う場所:
//   - エージェントの返答（ターン完了の行の `text`）の画像の参照（#321 と同じ `imageRefs()`）
//   - 自分の入力（`user_text`）の画像の参照と、地の文に書いた画像のパス（`この画像…: /Users/…/x.png`）
//   - SAI から添えた画像（`添付した画像:` の見出しの下。#135。配るのは既存の `/api/attachments/…`）
// 配る条件（realpath が行の cwd の中、PNG / JPEG / GIF / WebP、20MB 以下）は今までどおりサーバが決める。
// 一覧には載せて、読めないものは画面が名前だけ出す（`/tmp` の下のパスなど）
import { eventKind } from './events.ts'
import { imageName } from './markdown.ts'
import { attachmentUrlFromPath, splitAttachments } from './attachments.ts'
import { imageRefs, sessionImageUrl } from './images.ts'
import type { FeedRow, GalleryItem } from './types.ts'

export type { GalleryItem }


/** 返す上限（新しい順）。発言ごとの下に出すので、古い発言の画像を落とさない程度に大きく（#507） */
export const GALLERY_MAX = 500

const IMAGE_EXT = /\.(?:png|jpe?g|gif|webp)$/i
/** 地の文の絶対パス（空白・引用符・括弧・バッククォート・和文の句読点で切れる）。末尾の英字の句読点は落とす */
// `/` の直後が `/` のものは取らない（`https://host/a.png` の `//host/…` をパスと取り違えない。#505 のレビュー）
const BARE_PATH = /(?:^|[\s:：「(（])(\/[^\s'"`<>()（）「」、。，/][^\s'"`<>()（）「」、。，]*)/g

/**
 * 地の文に書かれた画像の絶対パス。Markdown の画像の書き方（`![](…)` / `[名前](…)`）は `imageRefs()` が拾うのでここでは見ない。
 * コードブロックの中も拾う（人が貼ったパスがそこにあることもある）が、拡張子が画像のものだけ
 */
export function bareImagePaths(text: string): string[] {
  const found: string[] = []
  for (const m of text.matchAll(BARE_PATH)) {
    const path = m[1]!.replace(/[.,;:!?、。]+$/, '')
    if (IMAGE_EXT.test(path) && !found.includes(path)) found.push(path)
  }
  return found
}

/**
 * 自分の入力（`user_text`）にある画像の参照（添付を除く）。サーバの `imageTable()` が配る表にもこれを足すので、
 * **画面とサーバが同じ 1 つを使う**（片方だけ変えると、一覧に出ても配れない）
 */
export function userImageSrcs(userText: string): string[] {
  const { body } = splitAttachments(userText)
  const out = imageRefs(body).map((r) => r.src)
  for (const path of bareImagePaths(body)) if (!out.includes(path) && !attachmentUrlFromPath(path)) out.push(path)
  return out
}

const ms = (ts: string) => {
  const t = Date.parse(ts)
  return Number.isNaN(t) ? 0 : t
}

/** 行から拾える画像（新しい順・同じ URL は最初に出てきたもの 1 つ）。`id` はセッションのエンティティ ID */
export function galleryFromRows(id: string, rows: readonly FeedRow[]): GalleryItem[] {
  const items: GalleryItem[] = []
  for (const r of rows) {
    const ts = String(r.ts ?? '')
    const at = new Date(ms(ts)).toISOString()
    const kind = eventKind(r.event, r.text)
    if (kind === 'turn' && r.text) {
      for (const ref of imageRefs(r.text)) items.push({ url: sessionImageUrl(id, ref.src), name: ref.alt || imageName(ref.src), at, ts, from: 'agent', source: 'text' })
    }
    if ((kind === 'turn' || kind === 'resume') && r.user_text) {
      for (const url of splitAttachments(r.user_text).urls) items.push({ url, name: imageName(url), at, ts, from: 'user', source: 'attachment' })
      for (const src of userImageSrcs(r.user_text)) items.push({ url: sessionImageUrl(id, src), name: imageName(src), at, ts, from: 'user', source: 'text' })
    }
  }
  return mergeGallery(items)
}

/** 並べる順（新しい順）にして、同じ URL は一番古いもの（最初に出てきた発言）だけ残し、上限で切る */
export function mergeGallery(items: readonly GalleryItem[]): GalleryItem[] {
  const first = new Map<string, GalleryItem>()
  for (const item of [...items].sort((a, b) => ms(a.at) - ms(b.at))) if (!first.has(item.url)) first.set(item.url, item)
  return [...first.values()].sort((a, b) => ms(b.at) - ms(a.at)).slice(0, GALLERY_MAX)
}

/**
 * その側のバブルが出る行か。自分の入力は再開の行とターン完了の行の `user_text`、エージェントはターン完了の行の返答と待ちの行。
 * `SubagentStop` などの other・`入力待ち` の idle・終わりの行は描かないので、そこに付けても出ない（#505 のレビュー）
 */
function hasBubble(r: FeedRow, from: GalleryItem['from']): boolean {
  const kind = eventKind(r.event, r.text)
  if (from === 'user') return (kind === 'resume' || kind === 'turn') && !!r.user_text
  return kind === 'turn' || kind === 'waiting'
}

/**
 * transcript の画像の時刻 → 付ける行の `ts`。**その秒以降で一番古い、その側のバブルが出る行**（端末で貼った画像は入力の行と同じ秒、
 * Read で開いた画像はそのターンの完了の行が後に来る）。行の `ts` は秒までなので、画像の時刻を秒に丸めてから比べる
 */
export function rowTsAtOrAfter(rows: readonly FeedRow[], at: string, from: GalleryItem['from'] = 'agent'): string {
  const floor = Math.floor(ms(at) / 1000) * 1000
  let best = ''
  let bestMs = Infinity
  for (const r of rows) {
    if (!hasBubble(r, from)) continue
    const t = ms(String(r.ts ?? ''))
    if (t >= floor && t < bestMs) {
      best = String(r.ts)
      bestMs = t
    }
  }
  return best
}

/** 発言のバブルの鍵（#507）。行の `ts` と側で 1 つのバブルが決まる（`Chat` の `data-ts` / `data-side` と同じ組） */
export const bubbleKey = (ts: string, from: GalleryItem['from']): string => `${ts}|${from}`

/**
 * 発言のバブルの下に足す画像（#507）。**バブルの中にもう出ているものは除く**: 返答の本文の画像（#321。`MarkdownImage`）と
 * SAI から添えた画像（`AttachedImages`）。残るのは、自分の入力に書いた画像のパスと、transcript の画像（端末で貼ったもの・Read で開いたもの）。
 * 並びは古い順（バブルの中で読む順）
 */
export function imagesByBubble(items: readonly GalleryItem[]): Map<string, GalleryItem[]> {
  const out = new Map<string, GalleryItem[]>()
  for (const item of [...items].sort((a, b) => ms(a.at) - ms(b.at))) {
    if (!item.ts || item.source === 'attachment' || (item.source === 'text' && item.from === 'agent')) continue
    const key = bubbleKey(item.ts, item.from)
    const list = out.get(key)
    if (list) list.push(item)
    else out.set(key, [item])
  }
  return out
}
