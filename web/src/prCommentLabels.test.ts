import { test } from 'node:test'
import assert from 'node:assert/strict'
import { commentAuthor, commentsHeading, foldLabel, reviewStateLabel } from './prCommentLabels.ts'

test('reviewStateLabel: 判定ごとの印。会話のコメント・知らない値は出さない', () => {
  assert.deepEqual(reviewStateLabel('APPROVED'), { label: '承認', tone: 'approved' })
  assert.deepEqual(reviewStateLabel('CHANGES_REQUESTED'), { label: '修正の依頼', tone: 'changes' })
  assert.equal(reviewStateLabel('COMMENTED')?.tone, 'plain')
  assert.equal(reviewStateLabel('DISMISSED')?.tone, 'plain')
  assert.equal(reviewStateLabel(undefined), null)
  assert.equal(reviewStateLabel('SOMETHING_NEW'), null)
})

test('foldLabel / commentAuthor / commentsHeading', () => {
  assert.equal(foldLabel('minimized'), 'GitHub で畳まれています')
  assert.equal(foldLabel('bot'), 'bot')
  assert.equal(foldLabel(undefined), '')
  assert.equal(commentAuthor(''), 'ghost')
  assert.equal(commentAuthor('alice'), 'alice')
  assert.equal(commentsHeading(3), 'コメント 3 件')
  assert.equal(commentsHeading(100, 4), 'コメント 100 件（古い 4 件は出していません）')
})
