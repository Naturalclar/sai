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

/** スライドで送るのに要る横の距離（px。#509） */
export const SWIPE_MIN_PX = 50
/** これより動かなければ「押しただけ」（画像の外なら閉じる） */
export const TAP_MAX_PX = 10

/**
 * スライドの量 → 送る向き（#509）。横に `SWIPE_MIN_PX` 以上、かつ縦より横に大きく動いたときだけ。
 * 左へ払う（dx < 0）と次、右へ払うと前（写真アプリと同じ）。縦のスクロールのつもりの動きでは送らない
 */
export function swipeStep(dx: number, dy: number): -1 | 0 | 1 {
  if (Math.abs(dx) < SWIPE_MIN_PX || Math.abs(dx) <= Math.abs(dy)) return 0
  return dx < 0 ? 1 : -1
}
