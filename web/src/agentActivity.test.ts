import { test } from 'node:test'
import assert from 'node:assert/strict'
import { activitySummary, heldStatusLabel, messageStatusLabel, targetWhyLabel } from './agentActivity.ts'
import { AGENT_TARGET_WHYS } from '../../shared/agentWaiting.ts'
import { WHY_LABEL } from '../../shared/holding.ts'
import type { AgentActivity } from '../../shared/types.ts'

const activity = (over: Partial<AgentActivity> = {}): AgentActivity => ({ stopped: false, sent: 0, limit: 3, read_tokens: 0, read_budget: 3_000_000, recent: [], ...over })

test('activitySummary: 往復数と読み直させた量は上限に近いときだけ出す（#311 / #823）', () => {
  assert.equal(activitySummary(activity({ sent: 2, read_tokens: 1_800_000 })), 'このターン 2/3 回 · 読み直させた量 約 180 万トークン / 約 300 万トークン')
  assert.equal(activitySummary(activity({ sent: 2 })), 'このターン 2/3 回', '相手の大きさが分からなければ量は出さない')
  assert.equal(activitySummary(activity({ sent: 1, read_tokens: 400_000 })), '', '線の手前なら何も出さない')
  assert.equal(activitySummary(activity()), '')
})

test('targetWhyLabel: 返答待ちの相手の状態は WHY_LABEL と同じ語。返答あり・失敗・別のリポジトリの相手には出さない（#823）', () => {
  for (const why of AGENT_TARGET_WHYS) assert.equal(targetWhyLabel({ status: 'pending', to_why: why }), WHY_LABEL[why])
  assert.equal(targetWhyLabel({ status: 'pending', to_why: 'busy' }), '処理中')
  assert.equal(targetWhyLabel({ status: 'pending' }), '', '分からなければ出さない')
  assert.equal(targetWhyLabel({ status: 'done', to_why: 'busy' }), '')
  assert.equal(targetWhyLabel({ status: 'failed', to_why: 'busy' }), '')
  assert.equal(targetWhyLabel({ status: 'pending', to_why: 'busy', far: true }), '', '別のリポジトリの相手には細かい語を出さない（#747）')
})

test('messageStatusLabel: 返答待ち / 返答あり / 失敗', () => {
  assert.equal(messageStatusLabel('pending'), '返答待ち')
  assert.equal(messageStatusLabel('done'), '返答あり')
  assert.equal(messageStatusLabel('failed'), '失敗')
})

test('預かり（#727）: 見出しに件数、行に何番目に送るか。止まっているものはそう出す', () => {
  const held = [{ message_id: 'h1', to: 'B1@r', to_name: 'セッション B', at: '2026-10-07T03:00:00Z' }]
  assert.equal(activitySummary(activity({ sent: 3, held })), 'このターン 3/3 回 · 預かり 1 件')
  assert.equal(activitySummary(activity({ held: [] })), '')
  assert.equal(heldStatusLabel({}, 0), '預かり（1 番目に送ります）')
  assert.equal(heldStatusLabel({ halted: '送っている途中で…' }, 1), '送っていません（止まっています）')
})
