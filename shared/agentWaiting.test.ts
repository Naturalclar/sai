import { test } from 'node:test'
import assert from 'node:assert/strict'
import { deliveredText } from './agentMessages.ts'
import {
  AGENT_READ_NEAR,
  AGENT_SENT_NEAR,
  ANSWER_SLACK_MS,
  agentActivityShown,
  agentWaitCount,
  agentWaitLabel,
  agentWaitShown,
  answeredIds,
  openMessages,
  readNear,
  sentNear,
} from './agentWaiting.ts'
import type { AgentActivity, AgentActivityMessage, FeedRow } from './types.ts'

const msg = (status: AgentActivityMessage['status'], n = 0): AgentActivityMessage => ({ message_id: `m${n}`, to: 'B1@r', to_name: 'セッション B', since: '2026-10-19T01:00:00Z', status })
const activity = (over: Partial<AgentActivity> = {}): AgentActivity => ({ stopped: false, sent: 0, limit: 3, read_tokens: 0, read_budget: 3_000_000, recent: [], ...over })

test('agentWaitCount: 返答待ち＋預かり（止まっていないもの）を waiting、失敗と止まった預かりを failed。返答ありは数えない', () => {
  assert.deepEqual(agentWaitCount({ recent: [msg('pending', 1), msg('done', 2), msg('pending', 3)] }), { waiting: 2, failed: 0 })
  assert.deepEqual(agentWaitCount({ recent: [msg('failed', 1)], held: [{}, { halted: '止まった' }] }), { waiting: 1, failed: 2 })
  assert.deepEqual(agentWaitCount({ recent: [msg('done', 1), msg('done', 2)] }), { waiting: 0, failed: 0 })
})

test('枠を出す条件（#823）: 返答待ち・失敗・預かり・止めている → 出る／全部返答あり・何も無い → 出ない', () => {
  assert.equal(agentActivityShown(activity({ recent: [msg('pending')] })), true)
  assert.equal(agentActivityShown(activity({ recent: [msg('failed')] })), true)
  assert.equal(agentActivityShown(activity({ held: [{ message_id: 'h', to: 'B1@r', to_name: 'セッション B', at: '2026-10-19T01:00:00Z' }] })), true)
  assert.equal(agentActivityShown(activity({ stopped: true, recent: [msg('done')] })), true)
  assert.equal(agentActivityShown(activity({ recent: [msg('done', 1), msg('done', 2)], sent: 3 })), false, '全部返答ありなら、上限まで送っていても出さない')
  assert.equal(agentActivityShown(activity()), false)
  assert.equal(agentActivityShown(undefined), false)
})

test('枠の中（#823）: 返答ありの行は出さない', () => {
  assert.deepEqual(openMessages([msg('done', 1), msg('pending', 2), msg('failed', 3)]).map((m) => m.message_id), ['m2', 'm3'])
})

test('往復数・読み直させた量は線の手前では出さず、越えると出す（#823）', () => {
  assert.equal(AGENT_SENT_NEAR, 2 / 3)
  assert.equal(sentNear({ sent: 1, limit: 3 }), false)
  assert.equal(sentNear({ sent: 2, limit: 3 }), true, '3 分の 2 ちょうどで出す')
  assert.equal(sentNear({ sent: 3, limit: 3 }), true)
  assert.equal(AGENT_READ_NEAR, 1 / 2)
  assert.equal(readNear({ read_tokens: 1_499_999, read_budget: 3_000_000 }), false)
  assert.equal(readNear({ read_tokens: 1_500_000, read_budget: 3_000_000 }), true, '半分ちょうどで出す')
  assert.equal(readNear({ read_tokens: 0, read_budget: 0 }), false, '分からなければ出さない')
})

test('一覧と見出しの印（#823）: 返答待ちがあればその数。失敗だけなら失敗の数。どちらも 0 なら出さない', () => {
  assert.equal(agentWaitShown({ waiting: 0, failed: 0 }), false)
  assert.equal(agentWaitShown(null), false)
  assert.equal(agentWaitShown({ waiting: 2, failed: 1 }), true)
  assert.equal(agentWaitLabel({ waiting: 2, failed: 1 }), '返答待ち 2')
  assert.equal(agentWaitLabel({ waiting: 0, failed: 1 }), '送信の失敗 1')
})

const reply = (ts: string, session: string, user_text: string): FeedRow => ({ ts, agent: 'claude', repo: 'r', branch: 'main', session, session_source: 'payload', cwd: '/w', event: 'Stop', text: 'はい', user_text, first_user_text: '' })
const delivered = (id: string) => deliveredText({ label: 'セッション A', project: 'o/r' }, id, '見て')

test('answeredIds: 送った相手の、そのメッセージで回ったターン完了の行だけを返答に数える（#823）', () => {
  const open = [
    { message_id: 'aa11', to: 'B1@r', since: '2026-10-19T01:00:00.500Z' },
    { message_id: 'bb22', to: 'C1@r', since: '2026-10-19T01:01:00Z' },
  ]
  const rows = [
    // 行の時刻は秒まで。送った時刻（ミリ秒つき）より少し前に見えても拾う
    reply('2026-10-19T01:00:00+00:00', 'B1', delivered('aa11')),
    // 見出しを写しただけの別の相手の行は数えない
    reply('2026-10-19T01:05:00+00:00', 'D1', delivered('bb22')),
  ]
  assert.deepEqual([...answeredIds(open, rows)], ['aa11'])
  assert.deepEqual([...answeredIds([], rows)], [])
})

test('answeredIds: 一番古い送った時刻より（余白を越えて）前の行は見ない', () => {
  const since = '2026-10-19T03:00:00Z'
  const old = new Date(Date.parse(since) - ANSWER_SLACK_MS - 60_000).toISOString()
  // 古い行に同じ id が見えても（実際には起きない）数えない = そこまで舐めていない
  assert.deepEqual([...answeredIds([{ message_id: 'aa11', to: 'B1@r', since }], [reply(old, 'B1', delivered('aa11'))])], [])
  // 送った時刻が読めなければ全部舐める
  assert.deepEqual([...answeredIds([{ message_id: 'aa11', to: 'B1@r', since: '' }], [reply(old, 'B1', delivered('aa11'))])], ['aa11'])
})
