// PR のレビューの判定を 1 か所で組む（#793）。
//
// GitHub の `reviewDecision` は、ブランチの保護でレビューを必須にしているときだけ値が入る。必須でないリポジトリでは
// 承認があっても空で返るので、SAI の「承認済み」の印が 1 本も出なかった。空のときは `latestReviews`（レビューした人ごとの
// 最新の判定）から SAI が判定を組む。
//
// - `reviewDecision` に値があればそのまま（レビュー必須のリポジトリは GitHub の判定に従う。古い承認の扱いもそちら）
// - 空のとき: 数える人（メンバー・オーナー・コラボレーター）の最新の判定に CHANGES_REQUESTED が 1 件でもあれば「修正の依頼あり」。
//   無くて APPROVED が 1 件でもあれば「承認済み」。ただし、承認した時のコミットが分かっていて今の head と全部違えば
//   「承認のあとに更新あり」（APPROVED_STALE）。コメントだけ・レビュー無し・外部の人やボットの承認だけなら空
// - 承認した時のコミットが取れない（古い gh・項目が無い）ときは時刻で代えず、「承認済み」のまま
//
// 純粋関数。サーバ（server/git/prs.ts・pr.ts）が `gh` の出力を読むときに通し、画面の 3 か所（一覧の行・PR 1 本の見出し・
// セッションの PR バッジ）は出来上がった `review_decision` を見るだけ（判定を別々に組まない）。
// レビューした人の名前はここから外に出さない（数えるのに使うだけ）。

/** `review_decision` に入る値。前からの 3 つ + SAI が組む `APPROVED_STALE`。無ければ空 */
export type ReviewDecision = 'APPROVED' | 'CHANGES_REQUESTED' | 'REVIEW_REQUIRED' | 'APPROVED_STALE' | ''

/** 数える承認・修正の依頼（`authorAssociation`）。外部の人（CONTRIBUTOR / FIRST_TIME_CONTRIBUTOR / NONE）とボットは数えない */
export const COUNTED_ASSOCIATIONS: ReadonlySet<string> = new Set(['MEMBER', 'OWNER', 'COLLABORATOR'])

const str = (v: unknown): string => (typeof v === 'string' ? v : '')

/** `gh` の `latestReviews` の 1 件から、判定に要る分だけ */
interface LatestReview {
  state: string
  association: string
  /** レビューした時のコミット（`commit.oid`）。項目が無い gh では空 */
  commit: string
}

function latestReviewsOf(raw: unknown): LatestReview[] {
  if (!Array.isArray(raw)) return []
  const out: LatestReview[] = []
  for (const r of raw) {
    if (!r || typeof r !== 'object') continue
    const o = r as Record<string, unknown>
    const commit = o.commit && typeof o.commit === 'object' ? str((o.commit as Record<string, unknown>).oid) : ''
    out.push({ state: str(o.state).toUpperCase(), association: str(o.authorAssociation).toUpperCase(), commit })
  }
  return out
}

/**
 * `gh pr list` / `gh pr view` の 1 件（`reviewDecision` / `latestReviews` / `headRefOid`）から判定。
 * 知らない `reviewDecision` の値は空にする（画面に知らない文字を出さない）
 */
export function reviewDecisionOf(o: { reviewDecision?: unknown; latestReviews?: unknown; headRefOid?: unknown }): ReviewDecision {
  const given = str(o.reviewDecision).toUpperCase()
  if (given === 'APPROVED' || given === 'CHANGES_REQUESTED' || given === 'REVIEW_REQUIRED') return given
  const counted = latestReviewsOf(o.latestReviews).filter((r) => COUNTED_ASSOCIATIONS.has(r.association))
  if (counted.some((r) => r.state === 'CHANGES_REQUESTED')) return 'CHANGES_REQUESTED'
  const approvals = counted.filter((r) => r.state === 'APPROVED')
  if (approvals.length === 0) return ''
  const head = str(o.headRefOid)
  // 承認した時のコミットが分かるものが 1 つでも今の head なら承認済み。全部が head と違えば「承認のあとに更新あり」。
  // コミットが取れない承認は「今の head」として数える（時刻で代えない。分からないときに承認を疑わない）
  const current = approvals.some((r) => !r.commit || !head || r.commit === head)
  return current ? 'APPROVED' : 'APPROVED_STALE'
}
