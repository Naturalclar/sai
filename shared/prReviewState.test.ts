import { test } from 'node:test'
import assert from 'node:assert/strict'
import { reviewDecisionOf } from './prReviewState.ts'

const review = (state: string, association = 'MEMBER', commit?: string) => ({ state, authorAssociation: association, author: { login: 'reviewer-a' }, ...(commit ? { commit: { oid: commit } } : {}) })
const HEAD = 'a'.repeat(40)
const OLD = 'b'.repeat(40)

test('reviewDecisionOf: reviewDecision に値があればそのまま（レビュー必須のリポジトリ）。知らない値は空', () => {
  assert.equal(reviewDecisionOf({ reviewDecision: 'APPROVED', latestReviews: [review('CHANGES_REQUESTED')] }), 'APPROVED', 'GitHub の判定を優先')
  assert.equal(reviewDecisionOf({ reviewDecision: 'CHANGES_REQUESTED' }), 'CHANGES_REQUESTED')
  assert.equal(reviewDecisionOf({ reviewDecision: 'REVIEW_REQUIRED' }), 'REVIEW_REQUIRED')
  assert.equal(reviewDecisionOf({ reviewDecision: 'approved' }), 'APPROVED', '大文字小文字は揃える')
  assert.equal(reviewDecisionOf({ reviewDecision: 'SOMETHING_NEW' }), '')
  assert.equal(reviewDecisionOf({ reviewDecision: 'APPROVED', latestReviews: [review('APPROVED', 'MEMBER', OLD)], headRefOid: HEAD }), 'APPROVED', '値があるときは古い承認の見分けをしない（GitHub の設定に従う）')
})

test('reviewDecisionOf: 空のときは数える人の最新の判定から。承認 1 件で承認済み、コメントだけ・無しは空', () => {
  assert.equal(reviewDecisionOf({ reviewDecision: '', latestReviews: [review('APPROVED')] }), 'APPROVED')
  assert.equal(reviewDecisionOf({ reviewDecision: null, latestReviews: [review('APPROVED', 'OWNER')] }), 'APPROVED')
  assert.equal(reviewDecisionOf({ latestReviews: [review('APPROVED', 'COLLABORATOR')] }), 'APPROVED')
  assert.equal(reviewDecisionOf({ reviewDecision: '', latestReviews: [review('COMMENTED')] }), '')
  assert.equal(reviewDecisionOf({ reviewDecision: '', latestReviews: [] }), '')
  assert.equal(reviewDecisionOf({ reviewDecision: '' }), '', '項目の無い古い gh の出力でも落ちない')
  assert.equal(reviewDecisionOf({ reviewDecision: '', latestReviews: 'junk' }), '')
  assert.equal(reviewDecisionOf({ reviewDecision: '', latestReviews: [null, 1, 'x', {}] }), '')
})

test('reviewDecisionOf: 承認と修正の依頼が別の人から出ていれば「修正の依頼あり」を先に', () => {
  assert.equal(reviewDecisionOf({ reviewDecision: '', latestReviews: [review('APPROVED'), review('CHANGES_REQUESTED', 'OWNER')] }), 'CHANGES_REQUESTED')
  assert.equal(reviewDecisionOf({ reviewDecision: '', latestReviews: [review('CHANGES_REQUESTED'), review('APPROVED')] }), 'CHANGES_REQUESTED')
  // 同じ人の最新が修正の依頼（latestReviews は人ごとの最新なので 1 件だけ来る）
  assert.equal(reviewDecisionOf({ reviewDecision: '', latestReviews: [review('CHANGES_REQUESTED')] }), 'CHANGES_REQUESTED')
})

test('reviewDecisionOf: 外部の人・ボットの承認は数えない', () => {
  for (const assoc of ['CONTRIBUTOR', 'FIRST_TIME_CONTRIBUTOR', 'FIRST_TIMER', 'NONE', 'MANNEQUIN', '']) {
    assert.equal(reviewDecisionOf({ reviewDecision: '', latestReviews: [review('APPROVED', assoc)] }), '', assoc || '(空)')
    assert.equal(reviewDecisionOf({ reviewDecision: '', latestReviews: [review('CHANGES_REQUESTED', assoc)] }), '', assoc || '(空)')
  }
  assert.equal(reviewDecisionOf({ reviewDecision: '', latestReviews: [review('APPROVED', 'NONE'), review('APPROVED', 'MEMBER')] }), 'APPROVED', 'メンバーの分だけ数える')
})

test('reviewDecisionOf: 承認した時のコミットが今の head と違えば「承認のあとに更新あり」。取れなければ承認済みのまま', () => {
  assert.equal(reviewDecisionOf({ reviewDecision: '', latestReviews: [review('APPROVED', 'MEMBER', HEAD)], headRefOid: HEAD }), 'APPROVED')
  assert.equal(reviewDecisionOf({ reviewDecision: '', latestReviews: [review('APPROVED', 'MEMBER', OLD)], headRefOid: HEAD }), 'APPROVED_STALE')
  assert.equal(reviewDecisionOf({ reviewDecision: '', latestReviews: [review('APPROVED', 'MEMBER', OLD), review('APPROVED', 'OWNER', HEAD)], headRefOid: HEAD }), 'APPROVED', '今の head への承認が 1 つでもあれば承認済み')
  assert.equal(reviewDecisionOf({ reviewDecision: '', latestReviews: [review('APPROVED', 'MEMBER')], headRefOid: HEAD }), 'APPROVED', 'コミットの項目が無い（古い gh）ときは時刻で代えず承認済み')
  assert.equal(reviewDecisionOf({ reviewDecision: '', latestReviews: [review('APPROVED', 'MEMBER', OLD)] }), 'APPROVED', 'head が分からなければ承認済み')
  assert.equal(reviewDecisionOf({ reviewDecision: '', latestReviews: [review('APPROVED', 'MEMBER', OLD), review('CHANGES_REQUESTED', 'OWNER', HEAD)], headRefOid: HEAD }), 'CHANGES_REQUESTED', '修正の依頼が先')
})
