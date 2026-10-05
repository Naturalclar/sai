import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ANSWERED_MAX, ANSWERED_TTL_MS, AnsweredApprovals } from './answered.ts'

const approval = (approval_id: string, id = 'S@r', text = `Codex の許可待ち: ${approval_id}`) => ({ approval_id, id, text })

test('答えたものを古い順に返す。別のセッションのものは混ざらない', () => {
  let now = Date.parse('2026-10-05T03:00:00Z')
  const a = new AnsweredApprovals(() => now)
  a.add(approval('a1'), 'allow', 'Yes, proceed')
  now += 1000
  a.add(approval('a2'), 'deny')
  a.add(approval('b1', 'T@r'), 'allow')
  assert.deepEqual(a.of('S@r'), [
    { approval_id: 'a1', text: 'Codex の許可待ち: a1', behavior: 'allow', at: '2026-10-05T03:00:00.000Z', label: 'Yes, proceed' },
    { approval_id: 'a2', text: 'Codex の許可待ち: a2', behavior: 'deny', at: '2026-10-05T03:00:01.000Z' },
  ])
  assert.deepEqual(a.of('T@r').map((x) => x.approval_id), ['b1'])
  assert.deepEqual(a.of('nobody@r'), [])
  assert.equal(a.key('S@r'), 'a1:allow,a2:deny')
})

test('最後のターン完了より前（同じ時刻も）に答えたものは出さない。ターンが終わったら消える', () => {
  let now = Date.parse('2026-10-05T03:00:00Z')
  const a = new AnsweredApprovals(() => now)
  a.add(approval('a1'), 'allow')
  now += 60_000
  a.add(approval('a2'), 'allow')
  assert.deepEqual(a.of('S@r', '2026-10-05T03:00:30Z').map((x) => x.approval_id), ['a2'])
  assert.deepEqual(a.of('S@r', '2026-10-05T03:01:00Z'), [], 'ターン完了と同じ時刻に答えたものは、そのターンのもの')
  assert.equal(a.key('S@r', '2026-10-05T03:01:00Z'), '')
  assert.deepEqual(a.of('S@r'), [], '一度ターンが終わったと分かったものは捨てている')
})

test('同じ許可を 2 回足しても 1 件。件数の上限を超えたら古い方から、古すぎるものも捨てる', () => {
  let now = Date.parse('2026-10-05T03:00:00Z')
  const a = new AnsweredApprovals(() => now)
  a.add(approval('a1'), 'deny')
  a.add(approval('a1'), 'allow')
  assert.deepEqual(a.of('S@r').map((x) => [x.approval_id, x.behavior]), [['a1', 'allow']])
  for (let i = 0; i < ANSWERED_MAX + 3; i++) a.add(approval(`n${i}`), 'allow')
  assert.equal(a.of('S@r').length, ANSWERED_MAX)
  assert.equal(a.of('S@r')[0]?.approval_id, 'n3')
  now += ANSWERED_TTL_MS + 1
  assert.deepEqual(a.of('S@r'), [])
})
