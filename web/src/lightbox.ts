import { createContext } from 'react'

/** ライトボックスに出す 1 枚（#507） */
export interface LightboxImage {
  url: string
  name: string
}

/**
 * 画像をページの中のライトボックスで開く関数（#507。別のタブ・ウィンドウは開かない）。`Chat` の `LightboxProvider` が渡し、
 * 画像のサムネイル（`MarkdownImage` / `AttachedImages` / `MessageImages`）が読む。null なら今までどおりリンクで開く
 * （ライトボックスの外で使われたとき）。`images` は同じ発言の画像で、`index` から ← → で送れる
 */
export type OpenLightbox = (images: LightboxImage[], index: number) => void

export const LightboxContext = createContext<OpenLightbox | null>(null)

/** ライトボックスの送り先。端で止める（回さない） */
export function stepIndex(index: number, count: number, delta: number): number {
  return Math.min(Math.max(index + delta, 0), Math.max(count - 1, 0))
}

/**
 * 修飾キー付きのクリック（新しいタブで開きたい）と中クリックはライトボックスで横取りしない。
 * 画像は `<a href>` のままなので、そのときはブラウザの既定の動きになる
 */
export function opensInPage(e: { button: number; metaKey: boolean; ctrlKey: boolean; shiftKey: boolean; altKey: boolean }): boolean {
  return e.button === 0 && !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey
}
