import { test } from 'node:test'
import assert from 'node:assert/strict'
import { activitySummary, messageStatusLabel } from './agentActivity.ts'
import type { AgentActivity } from '../../shared/types.ts'

const activity = (over: Partial<AgentActivity> = {}): AgentActivity => ({ stopped: false, sent: 0, limit: 3, read_tokens: 0, read_budget: 3_000_000, recent: [], ...over })

test('activitySummary: このターンの往復数と、読み直させた量（分かるときだけ）を 1 行に（#311）', () => {
  assert.equal(activitySummary(activity({ sent: 2, read_tokens: 1_800_000 })), 'このターン 2/3 回 · 読み直させた量 約 180 万トークン / 約 300 万トークン')
  assert.equal(activitySummary(activity({ sent: 1 })), 'このターン 1/3 回', '相手の大きさが分からなければ量は出さない')
  assert.equal(activitySummary(activity()), 'このターン 0/3 回', 'ターンを回していなければ 0')
})

test('messageStatusLabel: 返答待ち / 返答あり / 失敗', () => {
  assert.equal(messageStatusLabel('pending'), '返答待ち')
  assert.equal(messageStatusLabel('done'), '返答あり')
  assert.equal(messageStatusLabel('failed'), '失敗')
})
