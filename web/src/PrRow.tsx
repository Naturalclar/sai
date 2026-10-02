import type { PrSummary } from './api'
import { prHash } from '../../shared/prs.ts'
import { agoLabel, checkLabel } from './prLabels'
import { ReviewBadge } from './ReviewBadge'

/** PR の一覧の 1 行（#524）。押すと SAI の中で 1 本の画面を開く（GitHub へは 1 本の画面から飛ぶ） */
export function PrRow({ repo, pr, now }: { repo: string; pr: PrSummary; now: number }) {
  const check = checkLabel(pr.checks)
  return (
    <a className={`pr-row${pr.requested ? ' requested' : ''}${pr.draft ? ' draft' : ''}`} href={prHash(repo, pr.number)}>
      <span className="pr-title">
        <span className="num">#{pr.number}</span> {pr.title}
      </span>
      <span className="pr-meta">
        {pr.requested && <span className="tag requested">レビュー依頼</span>}
        {pr.draft && <span className="tag">下書き</span>}
        {check && (
          <span className={`check ${pr.checks}`} title={check.title}>
            {check.mark}
          </span>
        )}
        <span className="author">{pr.author}</span>
        <code className="branch" title={`${pr.head} → ${pr.base}`}>{pr.head}</code>
        <ReviewBadge decision={pr.review_decision} />
        <span className="counts">
          <span className="add">+{pr.additions}</span> <span className="del">−{pr.deletions}</span>
        </span>
        <span className="ago">{agoLabel(pr.updated_at, now)}</span>
      </span>
    </a>
  )
}
