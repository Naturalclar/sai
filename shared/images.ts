// 返答の本文にある手元の画像（#321）。サーバ（server/local/images.ts が配る）と画面（web/src/MarkdownImage.tsx が <img> にする）が
// 同じ鍵を作るためのもの。依存ゼロ・DOM 非依存なので node:test で回す（shared/images.test.ts）
import { parseMarkdown } from './markdown.ts'
import type { Inline } from './markdown.ts'

/** 配る画像の上限。本文から拾うのは作業の成果物（アイコン、スクリーンショット）なので、返信に添える画像（10MB）より大きめ */
export const IMAGE_MAX_BYTES = 20 * 1024 * 1024

/** `GET /api/sessions/<id>/images/<key>` の区切り。id は `/` を含まないので、最初の `/images/` が区切り */
export const IMAGES_SEGMENT = '/images/'

/**
 * 本文の画像を配れなかった理由の区分（#820）。サーバが `IMAGE_UNAVAILABLE_HEADER` に載せ、画面が名前の横に短く出す。
 * **パスは載せない**（区分だけ）。どうすれば出るかが区分ごとに違うので分ける。分からない失敗には付けない
 */
export const IMAGE_UNAVAILABLE = ['outside', 'missing', 'not-image', 'too-big', 'remote'] as const
export type ImageUnavailable = (typeof IMAGE_UNAVAILABLE)[number]

/** 配れなかった理由の区分を載せるヘッダ（失敗の応答だけに付く） */
export const IMAGE_UNAVAILABLE_HEADER = 'X-SAI-Image-Unavailable'

/** ヘッダの値を区分に読む。知らない値・無いものは null（理由を出さない） */
export function parseImageUnavailable(value: string | null | undefined): ImageUnavailable | null {
  return (IMAGE_UNAVAILABLE as readonly string[]).includes(value ?? '') ? (value as ImageUnavailable) : null
}

export interface ImageRef {
  /** 本文に書かれたパスそのもの（絶対パスか、行の cwd からの相対パス） */
  src: string
  /** `[]` の中（空のこともある） */
  alt: string
}

/**
 * 本文に書かれたパス → URL の鍵（16 桁）。サーバは行の本文から拾った参照の表をこの鍵で引き、**リクエストからパスは受けない**。
 * 画面でも同期で作れるよう暗号学的なハッシュにはしない（鍵は秘密ではなく、表に無い鍵は 404。重なっても同じセッションの別の画像が出るだけ）。
 * FNV-1a（32 bit）を 2 つの初期値で回してつなぐ
 */
export function imageKey(src: string): string {
  const fnv = (seed: number) => {
    let h = seed
    for (let i = 0; i < src.length; i++) {
      h ^= src.charCodeAt(i)
      h = Math.imul(h, 0x01000193)
    }
    return (h >>> 0).toString(16).padStart(8, '0')
  }
  return fnv(0x811c9dc5) + fnv(0x050c5d1f)
}

/** 本文の中の画像の参照（`image` ノード）を出てきた順に、同じパスは 1 つにして返す。コードブロックと `` `コード` `` の中は拾わない */
export function imageRefs(text: string): ImageRef[] {
  const found = new Map<string, ImageRef>()
  const walk = (nodes: Inline[]) => {
    for (const n of nodes) {
      if (n.kind === 'image') {
        if (!found.has(n.src)) found.set(n.src, { src: n.src, alt: n.alt })
      } else if (n.kind === 'strong' || n.kind === 'link') {
        walk(n.children)
      }
    }
  }
  for (const b of parseMarkdown(text)) {
    if (b.kind === 'paragraph' || b.kind === 'quote') b.lines.forEach(walk)
    else if (b.kind === 'heading') walk(b.children)
    else if (b.kind === 'list') for (const item of b.items) item.lines.forEach(walk)
  }
  return [...found.values()]
}

/** 画面が <img src> に使う URL。ダウンロードは末尾に `?download=1` */
export function sessionImageUrl(id: string, src: string): string {
  return `/api/sessions/${encodeURIComponent(id)}${IMAGES_SEGMENT}${imageKey(src)}`
}

/** 本文の画像の幅の上限（px）。`styles.css` の `.md-img > a:first-child` の `320px` と同じ値 */
export const BODY_IMAGE_WIDTH = 320
/**
 * 幅の上限まで縮めたときの高さがこれ（px）を切る画像を「帯」（横に細長い）と見なす（#702）。境目の縦横比は
 * `BODY_IMAGE_WIDTH / BAND_MIN_HEIGHT` = 4:1。帯は高さがこの値になるまで幅を広げる（境目で大きさが飛ばない）。
 * **画面（`web/src/imageShape.ts`）とサーバ（軽い版の大きさ。#709）が同じ値で見分ける**
 */
export const BAND_MIN_HEIGHT = 80

/** 帯（横に細長い画像）か。大きさが分からない（0・NaN）ものは帯にしない */
export function isBandImage(width: number, height: number): boolean {
  return width > 0 && height > 0 && width / height >= BODY_IMAGE_WIDTH / BAND_MIN_HEIGHT
}

/**
 * 枠に出す軽い版の URL（#589。`?thumb=<版>`）。ライトボックスとダウンロードは元の URL のまま。
 * 本文のパス・transcript・Codex の生成画像・添付の 4 つの口が同じ `?thumb=<版>` を受ける
 */
export function thumbUrl(url: string): string {
  return `${url}${url.includes('?') ? '&' : '?'}thumb=${THUMB_VERSION}`
}

/**
 * 軽い版の URL の版（`?thumb=<版>`）。軽い版の中身の作り方を変えたら上げる（#791 で 1 → 2: EXIF を落とすようになった）。
 * 添付の軽い版は `immutable` で 1 年キャッシュさせているので、URL を変えないとブラウザの持っている古い軽い版が使われ続ける
 */
export const THUMB_VERSION = '2'

/** 押すまで読まない画像の大きさ（`2.3MB` / `480KB`） */
export function formatImageBytes(n: number): string {
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)}MB`
  return `${Math.max(1, Math.round(n / 1024))}KB`
}
