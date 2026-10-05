import { BAND_MIN_HEIGHT, BODY_IMAGE_WIDTH, isBandImage } from '../../shared/images.ts'

/** 本文の画像の幅の上限（px）と、帯と見なす高さ。値は `shared/images.ts`（サーバの軽い版と同じ見分け。#709） */
export const THUMB_WIDTH = BODY_IMAGE_WIDTH
export { BAND_MIN_HEIGHT }
/**
 * 帯をバブルの幅に収めても、高さをこれ（px）より小さくは縮めない（元がもっと低ければ元の高さ）。
 * 収まらないぶんは枠の中で横にスクロールする（携帯の幅で 1084×27 が高さ 9px の線にならないように）
 */
export const BAND_FLOOR_HEIGHT = 18

/** 帯の出し方（px）。`cap` は幅の上限、`floor` はこれより狭くしない幅 */
export interface BandLayout {
  cap: number
  floor: number
}

/**
 * 読み込んだ画像の大きさ → 帯ならその出し方、ふつう・縦長・大きさが分からない（0・NaN）ものは null（今までどおり）。
 * 元の大きさより大きくはしない
 */
export function bandLayout(width: number, height: number): BandLayout | null {
  if (!isBandImage(width, height)) return null
  const ratio = width / height
  const cap = Math.min(width, Math.round(ratio * BAND_MIN_HEIGHT))
  return { cap, floor: Math.min(cap, Math.round(ratio * Math.min(height, BAND_FLOOR_HEIGHT))) }
}
