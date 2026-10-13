import { test } from 'node:test'
import assert from 'node:assert/strict'
import { latestOpinionated, PR_LIST_REVIEWS_JQ, PR_VIEW_REVIEWS_JQ, reviewDecisionOf, reviewsOf } from './prReviewState.ts'

let seq = 0
const review = (state: string, association = 'MEMBER', commit?: string, login = 'reviewer-a') => ({
  state,
  authorAssociation: association,
  author: { login },
  submittedAt: new Date(Date.UTC(2026, 0, 1, 0, 0, ++seq)).toISOString(),
  ...(commit ? { commit: { oid: commit } } : {}),
})
const HEAD = 'a'.repeat(40)
const OLD = 'b'.repeat(40)

test('reviewDecisionOf: reviewDecision に値があればそのまま（レビュー必須のリポジトリ）。知らない値は空で、組み立てに落ちない', () => {
  assert.equal(reviewDecisionOf({ reviewDecision: 'APPROVED', reviews: [review('CHANGES_REQUESTED')] }), 'APPROVED', 'GitHub の判定を優先')
  assert.equal(reviewDecisionOf({ reviewDecision: 'CHANGES_REQUESTED' }), 'CHANGES_REQUESTED')
  assert.equal(reviewDecisionOf({ reviewDecision: 'REVIEW_REQUIRED' }), 'REVIEW_REQUIRED')
  assert.equal(reviewDecisionOf({ reviewDecision: 'approved' }), 'APPROVED', '大文字小文字は揃える')
  assert.equal(reviewDecisionOf({ reviewDecision: 'SOMETHING_NEW' }), '')
  assert.equal(reviewDecisionOf({ reviewDecision: 'SOMETHING_NEW', reviews: [review('APPROVED')] }), '', '知らない値のときに reviews から組まない（GitHub の判定を上書きしない）')
  assert.equal(reviewDecisionOf({ reviewDecision: 'APPROVED', reviews: [review('APPROVED', 'MEMBER', OLD)], headRefOid: HEAD }), 'APPROVED', '値があるときは古い承認の見分けをしない')
})

test('reviewDecisionOf: 空のときは数える人の最新の意見のあるレビューから。承認 1 件で承認済み、コメントだけ・無しは空', () => {
  assert.equal(reviewDecisionOf({ reviewDecision: '', reviews: [review('APPROVED')] }), 'APPROVED')
  assert.equal(reviewDecisionOf({ reviewDecision: null, reviews: [review('APPROVED', 'OWNER')] }), 'APPROVED')
  assert.equal(reviewDecisionOf({ reviews: [review('APPROVED', 'COLLABORATOR')] }), 'APPROVED')
  assert.equal(reviewDecisionOf({ reviewDecision: '', reviews: [review('COMMENTED')] }), '')
  assert.equal(reviewDecisionOf({ reviewDecision: '', reviews: [] }), '')
  assert.equal(reviewDecisionOf({ reviewDecision: '' }), '', '項目の無い古い gh の出力でも落ちない')
  assert.equal(reviewDecisionOf({ reviewDecision: '', reviews: 'junk' }), '')
  assert.equal(reviewDecisionOf({ reviewDecision: '', reviews: [null, 1, 'x', {}] }), '')
})

test('reviewDecisionOf: 承認した人があとでコメントだけ返しても承認は残る。取り消し（DISMISSED）と修正の依頼で変わる', () => {
  assert.equal(reviewDecisionOf({ reviewDecision: '', reviews: [review('APPROVED'), review('COMMENTED')] }), 'APPROVED', 'COMMENTED は意見を変えない')
  assert.equal(reviewDecisionOf({ reviewDecision: '', reviews: [review('APPROVED'), review('DISMISSED')] }), '', '取り消されたら無し')
  assert.equal(reviewDecisionOf({ reviewDecision: '', reviews: [review('APPROVED'), review('CHANGES_REQUESTED')] }), 'CHANGES_REQUESTED', '同じ人の最新が修正の依頼')
  assert.equal(reviewDecisionOf({ reviewDecision: '', reviews: [review('CHANGES_REQUESTED'), review('APPROVED')] }), 'APPROVED', '修正の依頼のあとに承認し直した')
  assert.equal(reviewDecisionOf({ reviewDecision: '', reviews: [review('CHANGES_REQUESTED', 'MEMBER', undefined, 'reviewer-a'), review('APPROVED', 'OWNER', undefined, 'reviewer-b')] }), 'CHANGES_REQUESTED', '別の人の修正の依頼が先')
})

test('reviewDecisionOf: 外部の人・ボットの承認は数えない', () => {
  for (const assoc of ['CONTRIBUTOR', 'FIRST_TIME_CONTRIBUTOR', 'FIRST_TIMER', 'NONE', 'MANNEQUIN', '']) {
    assert.equal(reviewDecisionOf({ reviewDecision: '', reviews: [review('APPROVED', assoc)] }), '', assoc || '(空)')
    assert.equal(reviewDecisionOf({ reviewDecision: '', reviews: [review('CHANGES_REQUESTED', assoc)] }), '', assoc || '(空)')
  }
  assert.equal(reviewDecisionOf({ reviewDecision: '', reviews: [review('APPROVED', 'NONE', undefined, 'outsider'), review('APPROVED', 'MEMBER')] }), 'APPROVED', 'メンバーの分だけ数える')
})

test('reviewDecisionOf: 承認した時のコミットが今の head と違えば「承認のあとに更新あり」。取れなければ承認済みのまま', () => {
  assert.equal(reviewDecisionOf({ reviewDecision: '', reviews: [review('APPROVED', 'MEMBER', HEAD)], headRefOid: HEAD }), 'APPROVED')
  assert.equal(reviewDecisionOf({ reviewDecision: '', reviews: [review('APPROVED', 'MEMBER', OLD)], headRefOid: HEAD }), 'APPROVED_STALE')
  assert.equal(reviewDecisionOf({ reviewDecision: '', reviews: [review('APPROVED', 'MEMBER', OLD, 'reviewer-a'), review('APPROVED', 'OWNER', HEAD, 'reviewer-b')], headRefOid: HEAD }), 'APPROVED', '今の head への承認が 1 つでもあれば承認済み')
  assert.equal(reviewDecisionOf({ reviewDecision: '', reviews: [review('APPROVED', 'MEMBER', OLD), review('APPROVED', 'MEMBER', HEAD)], headRefOid: HEAD }), 'APPROVED', '同じ人が head を承認し直した')
  assert.equal(reviewDecisionOf({ reviewDecision: '', reviews: [review('APPROVED', 'MEMBER')], headRefOid: HEAD }), 'APPROVED', 'コミットの項目が無い（古い gh）ときは時刻で代えず承認済み')
  assert.equal(reviewDecisionOf({ reviewDecision: '', reviews: [review('APPROVED', 'MEMBER', OLD)] }), 'APPROVED', 'head が分からなければ承認済み')
  assert.equal(reviewDecisionOf({ reviewDecision: '', reviews: [review('APPROVED', 'MEMBER', OLD, 'reviewer-a'), review('CHANGES_REQUESTED', 'OWNER', HEAD, 'reviewer-b')], headRefOid: HEAD }), 'CHANGES_REQUESTED', '修正の依頼が先')
})

test('latestOpinionated: 人ごとに最新、submittedAt の順（無ければ並び順）。名前の無いレビューは別々に数える', () => {
  const a1 = { ...reviewsOf([review('APPROVED', 'MEMBER', OLD)])[0]!, submittedAt: '2026-01-02T00:00:00Z' }
  const a2 = { ...reviewsOf([review('CHANGES_REQUESTED', 'MEMBER', HEAD)])[0]!, submittedAt: '2026-01-01T00:00:00Z' }
  assert.deepEqual(latestOpinionated([a1, a2]).map((r) => r.state), ['APPROVED'], '並びが逆でも submittedAt で後の方')
  const noName = reviewsOf([{ state: 'APPROVED', authorAssociation: 'MEMBER' }, { state: 'APPROVED', authorAssociation: 'MEMBER' }])
  assert.equal(latestOpinionated(noName).length, 2)
})

test('jq は要る項目だけに絞る（本文・リアクション・名前以外の author は読まない）', () => {
  for (const jq of [PR_LIST_REVIEWS_JQ, PR_VIEW_REVIEWS_JQ]) {
    assert.match(jq, /state, authorAssociation, submittedAt, author: \{login: \.author\.login\}, commit: \{oid: \.commit\.oid\}/)
    assert.doesNotMatch(jq, /body|reactionGroups/)
  }
})
