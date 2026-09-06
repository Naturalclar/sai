// サイドバーの項目を左にスワイプしてアーカイブを出す、その判定。DOM に依存しないので node:test で回す（swipe.test.ts）

/** これ未満の動きは「触っただけ」。閉じたまま */
export const SWIPE_DEAD = 24
/** 開いたときに止まる幅（右から出るレールの幅） */
export const RAIL_WIDTH = 72
/** 項目の幅のこの割合を超えて離せば、止めずにそのまま実行（Gmail と同じ） */
export const COMMIT_RATIO = 0.45
/** 横か縦かを決めるまでに必要な動き。これ未満ではどちらとも決めない（縦スクロールを邪魔しない） */
export const DECIDE_AFTER = 8

export type SwipeState = 'closed' | 'open' | 'commit'

/**
 * 指を離したときの結果。dx は左が負（右へは開かない）。
 * 幅の COMMIT_RATIO を超えていれば commit、SWIPE_DEAD を超えていれば open、それ未満は closed
 */
export function swipeState(dx: number, width: number): SwipeState {
  const left = -dx
  if (width > 0 && left > width * COMMIT_RATIO) return 'commit'
  if (left >= SWIPE_DEAD) return 'open'
  return 'closed'
}

/** 表示に使うずれ。右へは 0 で止め、左は項目の幅まで */
export function clampOffset(dx: number, width: number): number {
  if (dx > 0) return 0
  return width > 0 ? Math.max(dx, -width) : dx
}

/**
 * 横のスワイプか。まだ決められなければ null（両方向とも DECIDE_AFTER 未満）。
 * 縦のほうが大きければ false で、以後はスクロールに任せる
 */
export function isHorizontal(dx: number, dy: number): boolean | null {
  const ax = Math.abs(dx)
  const ay = Math.abs(dy)
  if (ax < DECIDE_AFTER && ay < DECIDE_AFTER) return null
  return ax > ay
}
