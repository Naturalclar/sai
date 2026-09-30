import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseReviewBodies, PR_REVIEW_DRAFTS_MAX, withReviewBody } from './prReviewDraft.ts'

test('parseReviewBodies: 壊れていれば空、形の合わないものは捨てる', () => {
  assert.deepEqual(parseReviewBodies(null), {})
  assert.deepEqual(parseReviewBodies('{'), {})
  assert.deepEqual(parseReviewBodies('[]'), {})
  assert.deepEqual(parseReviewBodies(JSON.stringify({ a: { body: 'x', at: 1 }, b: { body: ' ', at: 1 }, c: 'x', d: { body: 'y' } })), { a: { body: 'x', at: 1 } })
})

test('withReviewBody: 空なら消し、上限を超えたら古いものから捨てる', () => {
  let all = withReviewBody({}, 'a', '全体', 1)
  assert.deepEqual(all, { a: { body: '全体', at: 1 } })
  all = withReviewBody(all, 'a', '  ', 2)
  assert.deepEqual(all, {})
  for (let i = 0; i < PR_REVIEW_DRAFTS_MAX + 2; i++) all = withReviewBody(all, `k${i}`, 'x', i)
  assert.equal(Object.keys(all).length, PR_REVIEW_DRAFTS_MAX)
  assert.equal(all.k0, undefined)
  assert.equal(all.k1, undefined)
  assert.ok(all[`k${PR_REVIEW_DRAFTS_MAX + 1}`])
})
