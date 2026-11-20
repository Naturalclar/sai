import { test } from 'node:test'
import assert from 'node:assert/strict'
import { placeRequests, requestItemLabel, requestSummary } from './agentRequests.ts'
import type { AgentRequest, FeedRow } from '../../shared/types.ts'

const item = (message_id: string, status: AgentRequest['items'][number]['status'], extra: Partial<AgentRequest['items'][number]> = {}) => ({ message_id, to: 'b@r', to_name: 'セッション B', status, at: '2026-11-20T01:00:05Z', ...extra })

test('見出しは件数と状態ごとの数（0 件の状態は出さない）', () => {
  assert.equal(requestSummary({ items: [item('a', 'done'), item('b', 'pending'), item('c', 'held'), item('d', 'pending')] }), '4 件 · 返答あり 1 · 返答待ち 2 · 預かり 1')
  assert.equal(requestSummary({ items: [item('a', 'failed')] }), '1 件 · 失敗 1')
})

test('返答ありでも返答の行が見つからなければそう書く。止まった預かりは送っていないと書く', () => {
  assert.equal(requestItemLabel(item('a', 'done', { reply_ts: '2026-11-20T01:10:00Z' })), '返答あり')
  assert.equal(requestItemLabel(item('a', 'done')), '返答あり（返答の行が見つかりません）')
  assert.equal(requestItemLabel(item('a', 'failed', { halted: '止まりました' })), '失敗（送っていません）')
  assert.equal(requestItemLabel(item('a', 'held')), '預かり')
})

const turnRow = (ts: string, event = 'Stop'): FeedRow => ({ ts, session: 'a', repo: 'r', agent: 'claude', event, text: '返答' }) as FeedRow

test('依頼したターンの次のターン完了の行に置く。いま回しているターン・まだ終わっていないターンは末尾', () => {
  const rows = [turnRow('2026-11-20T00:59:00Z'), turnRow('2026-11-20T01:00:00Z', 'UserPromptSubmit'), turnRow('2026-11-20T01:05:00Z'), turnRow('2026-11-20T02:05:00Z')]
  const t1: AgentRequest = { turn: '2026-11-20T01:00:00.400Z', items: [item('a', 'done')] }
  const t2: AgentRequest = { turn: '2026-11-20T02:00:00.000Z', items: [item('b', 'pending')] }
  const t3: AgentRequest = { turn: '2026-11-20T03:00:00.000Z', items: [item('c', 'held')] }
  const placed = placeRequests([t1, t2, t3], rows)
  assert.deepEqual([...placed.at.entries()].map(([ts, list]) => [ts, list.map((r) => r.turn)]), [
    ['2026-11-20T01:05:00Z', [t1.turn]],
    ['2026-11-20T02:05:00Z', [t2.turn]],
  ])
  assert.deepEqual(placed.tail, [t3], 'ターン完了の行がまだ無い依頼は末尾')
  const running = placeRequests([t1, t2], rows, t2.turn)
  assert.deepEqual(running.tail, [t2], 'いま回しているターンの依頼は、前のターンの行があっても末尾')
})
