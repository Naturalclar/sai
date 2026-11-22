import { test } from 'node:test'
import assert from 'node:assert/strict'
import { agentRequests, agentRequestsKey, requestsFloor, requestsWindowStart } from './agentRequests.ts'
import type { AgentActivityMessage } from './types.ts'

const T1 = '2026-11-20T01:00:00.000Z'
const T2 = '2026-11-20T02:00:00.000Z'
const T3 = '2026-11-20T03:00:00.000Z'
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
  // 確かめる成果（#903）: 付いた・直したあとの返答に移った・確認済みにした・PR が変わったで変わる
  const withResult = (result: object) => [{ turn: T1, items: [{ ...linked[0]!.items[0]!, result: { ts: T2, ...result } }] }]
  const keys = [linked, withResult({}), withResult({ ts: T3 }), withResult({ checked_at: T3 }), withResult({ prs: [{ repo: 'o/r', number: 1 }] })].map(agentRequestsKey)
  assert.equal(new Set(keys).size, keys.length)
  assert.equal(agentRequestsKey(undefined), '')
})

test('載せる線は描いていないターン完了の行の一番新しい時刻。落としていなければ読んだ日の頭', () => {
  const stop = (ts: string) => ({ ts, event: 'Stop', text: '返答' })
  const prompt = (ts: string) => ({ ts, event: 'UserPromptSubmit', text: '' })
  assert.equal(requestsWindowStart([stop('2026-11-10T00:00:00Z'), stop('2026-11-12T00:00:00Z'), stop('x'), prompt('2026-11-13T00:00:00Z')], 0), Date.parse('2026-11-12T00:00:00Z'), '入力の行だけが落ちた（切れ目をまたぐ）ターンは線を押し上げない')
  assert.equal(requestsWindowStart([], 123), 123)
  assert.equal(requestsWindowStart([prompt('2026-11-13T00:00:00Z'), stop('')], 123), 123, 'ターン完了の行が落ちていない・時刻が読めなければ読んだ日の頭')
  const many = Array.from({ length: 200_000 }, (_, i) => stop(new Date(Date.parse('2026-01-01T00:00:00Z') + i * 1000).toISOString()))
  assert.equal(requestsWindowStart(many, 0), Date.parse(many.at(-1)!.ts), '行が多くても引数の上限に当たらない')
})

test('読んだ日の頭は Asia/Tokyo の 0 時', () => {
  assert.equal(requestsFloor('2026-11-14'), Date.parse('2026-11-13T15:00:00Z'))
  assert.equal(requestsFloor(undefined), -Infinity)
})
