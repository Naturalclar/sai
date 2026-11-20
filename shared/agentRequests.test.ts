import { test } from 'node:test'
import assert from 'node:assert/strict'
import { agentRequests, agentRequestsKey } from './agentRequests.ts'
import type { AgentActivityMessage } from './types.ts'

const T1 = '2026-11-20T01:00:00.000Z'
const T2 = '2026-11-20T02:00:00.000Z'
const names: Record<string, string> = { 'a@r': 'セッション A', 'b@r': 'セッション B', 'c@r': 'セッション C', 'far@x': 'セッション D' }
const nameOf = (to: string) => names[to] ?? to

test('ターンごとに束ね、預かり・返答待ち・返答あり・失敗を見分ける。別のターンの依頼は混ざらない', () => {
  const statuses: Record<string, AgentActivityMessage['status']> = { m1: 'done', m2: 'pending', m3: 'failed', m4: 'pending' }
  const got = agentRequests(
    [
      { message_id: 'm1', to: 'a@r', since: '2026-11-20T01:00:05.000Z', turn: T1 },
      { message_id: 'm2', to: 'b@r', since: '2026-11-20T01:00:06.000Z', turn: T1 },
      { message_id: 'm3', to: 'c@r', since: '2026-11-20T01:00:07.000Z', turn: T1 },
      { message_id: 'm4', to: 'a@r', since: '2026-11-20T02:00:05.000Z', turn: T2 },
    ],
    [
      { message_id: 'h1', to: 'far@x', turn: T1, at: '2026-11-20T01:00:08.000Z', far: true },
      { message_id: 'h2', to: 'b@r', turn: T1, at: '2026-11-20T01:00:09.000Z', halted: '止まりました' },
    ],
    (id) => statuses[id],
    nameOf,
    new Map([['m1', '2026-11-20T01:30:00Z']]),
  )
  assert.deepEqual(
    got.map((r) => ({ turn: r.turn, items: r.items.map((i) => `${i.message_id}:${i.status}`) })),
    [
      { turn: T1, items: ['m1:done', 'm2:pending', 'm3:failed', 'h1:held', 'h2:failed'] },
      { turn: T2, items: ['m4:pending'] },
    ],
  )
  const [first] = got
  assert.equal(first!.items[0]!.reply_ts, '2026-11-20T01:30:00Z')
  assert.equal(first!.items[0]!.to_name, 'セッション A')
  assert.equal(first!.items[1]!.reply_ts, undefined, '返答の行が無ければ付けない')
  assert.equal(first!.items[3]!.far, true, '別のリポジトリの相手の印を引き継ぐ')
  assert.equal(first!.items[4]!.halted, '止まりました', '預かりのまま止まったものは失敗で、理由を付ける')
})

test('ターンの無い記録は束ねない・状態が分からなければ返答待ち・窓の前に始まったターンは載せない', () => {
  const sent = [
    { message_id: 'old', to: 'a@r', since: '2026-11-19T00:00:00.000Z' },
    { message_id: 'm1', to: 'a@r', since: '2026-11-20T01:00:05.000Z', turn: T1 },
    { message_id: 'm2', to: 'b@r', since: '2026-11-20T02:00:05.000Z', turn: T2 },
  ]
  const all = agentRequests(sent, [], () => undefined, nameOf)
  assert.deepEqual(all.map((r) => r.turn), [T1, T2])
  assert.equal(all[0]!.items[0]!.status, 'pending')
  const windowed = agentRequests(sent, [], () => undefined, nameOf, new Map(), Date.parse('2026-11-20T01:30:00Z'))
  assert.deepEqual(windowed.map((r) => r.turn), [T2])
})

test('rev の鍵は状態と返答の行で変わる', () => {
  const base = [{ turn: T1, items: [{ message_id: 'm1', to: 'a@r', to_name: 'A', status: 'pending' as const, at: T1 }] }]
  const done = [{ turn: T1, items: [{ ...base[0]!.items[0]!, status: 'done' as const }] }]
  const linked = [{ turn: T1, items: [{ ...done[0]!.items[0]!, reply_ts: T2 }] }]
  assert.notEqual(agentRequestsKey(base), agentRequestsKey(done))
  assert.notEqual(agentRequestsKey(done), agentRequestsKey(linked))
  assert.equal(agentRequestsKey(undefined), '')
})
