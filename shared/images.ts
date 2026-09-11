// 返答の本文にある手元の画像（#321）。サーバ（server/local/images.ts が配る）と画面（web/src/MarkdownImage.tsx が <img> にする）が
// 同じ鍵を作るためのもの。依存ゼロ・DOM 非依存なので node:test で回す（shared/images.test.ts）
import { parseMarkdown } from './markdown.ts'
import type { Inline } from './markdown.ts'

/** 配る画像の上限。本文から拾うのは作業の成果物（アイコン、スクリーンショット）なので、返信に添える画像（10MB）より大きめ */
export const IMAGE_MAX_BYTES = 20 * 1024 * 1024

/** `GET /api/sessions/<id>/images/<key>` の区切り。id は `/` を含まないので、最初の `/images/` が区切り */
export const IMAGES_SEGMENT = '/images/'

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
