import { ApprovedMark } from './ApprovedMark'
import { isApproved, reviewLabel } from './prLabels'

/** PR 一覧の行と PR 画面に出すレビューの判定（#524）。承認済みならチェックの印（#636）。判定が無ければ何も出さない */
export function ReviewBadge({ decision, size = 12 }: { decision: string; size?: number }) {
  const label = reviewLabel(decision)
  if (!label) return null
  return (
    <span className={`review ${decision.toLowerCase()}`}>
      {isApproved(decision) && <ApprovedMark size={size} />}
      {label}
    </span>
  )
}
