import { ApprovedMark } from './ApprovedMark'
import { isApproved, isStaleApproval, reviewLabel } from './prLabels'

/**
 * PR 一覧の行と PR 画面に出すレビューの判定（#524）。承認済みならチェックの印（#636）。
 * 承認のあとに更新があれば、同じ形の印を別の色（`stale`）で出す（#793。緑のチェックと見分ける）。判定が無ければ何も出さない
 */
export function ReviewBadge({ decision, size = 12 }: { decision: string; size?: number }) {
  const label = reviewLabel(decision)
  if (!label) return null
  const stale = isStaleApproval(decision)
  return (
    <span className={`review ${decision.toLowerCase()}`} title={stale ? '承認のあとにコミットが積まれています（承認した時の head と違う）' : undefined}>
      {(isApproved(decision) || stale) && <ApprovedMark size={size} stale={stale} />}
      {label}
    </span>
  )
}
