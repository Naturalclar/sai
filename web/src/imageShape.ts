/** 本文の画像の幅の上限（px）。`styles.css` の `.md-img > a:first-child` の `320px` と同じ値 */
export const THUMB_WIDTH = 320
/**
 * 幅の上限まで縮めたときの高さがこれ（px）を切る画像を「帯」（横に細長い）と見なす（#702）。境目の縦横比は
 * `THUMB_WIDTH / BAND_MIN_HEIGHT` = 4:1。帯は高さがこの値になるまで幅を広げる（境目で大きさが飛ばない）
 */
export const BAND_MIN_HEIGHT = 80
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
  if (!(width > 0) || !(height > 0)) return null
  const ratio = width / height
  if (ratio < THUMB_WIDTH / BAND_MIN_HEIGHT) return null
  const cap = Math.min(width, Math.round(ratio * BAND_MIN_HEIGHT))
  return { cap, floor: Math.min(cap, Math.round(ratio * Math.min(height, BAND_FLOOR_HEIGHT))) }
}
