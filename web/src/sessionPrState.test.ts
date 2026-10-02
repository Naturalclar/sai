// サイドバーの PR の印の色と説明（#548）
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { sessionPrTag } from './sessionPrState.ts'
import type { PrSummary } from '../../shared/types.ts'

const pr = (over: Partial<PrSummary> = {}): PrSummary => ({
  number: 7, title: '直す', author: 'me', head: 'b', base: 'main', draft: false, updated_at: '', url: '', additions: 0, deletions: 0,
  changed_files: 0, review_decision: '', checks: '', requested: false, ...over,
})

test('色は 下書き → チェックが落ちている → 承認済み → それ以外 の順に 1 つ', () => {
  assert.equal(sessionPrTag(pr({ draft: true, checks: 'failure' })).state, 'draft')
  assert.equal(sessionPrTag(pr({ checks: 'failure', review_decision: 'APPROVED' })).state, 'failing')
  assert.equal(sessionPrTag(pr({ review_decision: 'APPROVED' })).state, 'approved')
  assert.equal(sessionPrTag(pr({ checks: 'pending' })).state, 'open')
  // 印（#636）は色とは別。承認されていれば下書き・チェック落ちでも付く
  assert.equal(sessionPrTag(pr({ draft: true, review_decision: 'APPROVED' })).approved, true)
  assert.equal(sessionPrTag(pr({ checks: 'failure', review_decision: 'APPROVED' })).approved, true)
  assert.equal(sessionPrTag(pr({ review_decision: 'CHANGES_REQUESTED' })).approved, false)
})

test('title は題名と分かるぶんの状態', () => {
  assert.equal(sessionPrTag(pr()).title, 'PR #7 直す')
  assert.equal(sessionPrTag(pr({ checks: 'success', review_decision: 'REVIEW_REQUIRED' })).title, 'PR #7 直す（チェックは通っています・レビュー待ち）')
})
