import type { PrSummary } from '../../shared/types.ts'
import { ApprovedMark } from './ApprovedMark'
import { GitHubMark } from './GitHubMark'
import type { sessionPrTag } from './sessionPrState.ts'

/** サイドバーの印（`SessionPrTag`）とリンク（`SessionPrLink`）の中身。`GitHub の印 + #番号`、承認済みならチェックの印（#636）。外側の要素（span / a）は呼ぶ側 */
export function SessionPrBadge({ pr, tag }: { pr: PrSummary; tag: ReturnType<typeof sessionPrTag> }) {
  return (
    <>
      <GitHubMark size={10} />#{pr.number}
      {tag.approved && <ApprovedMark size={10} />}
    </>
  )
}
