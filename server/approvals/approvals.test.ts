import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Approvals } from './approvals.ts'

test('ask → answer → wait で決定が渡り、渡したら消える', async () => {
  const a = new Approvals()
  const ap = a.ask('S@r', 'Bash', { command: 'ls' }, 't1')
  assert.equal(ap.text, '許可待ち: Bash: ls')
  assert.deepEqual(Object.keys(a.snapshot()), ['S@r'])
  assert.equal(await a.wait(ap.approval_id, 0), null, 'まだ答えが無い')
  const waiting = a.wait(ap.approval_id, 5_000)
  assert.equal(a.answer(ap.approval_id, { behavior: 'allow', updatedInput: { command: 'ls' } }), true)
  assert.deepEqual(await waiting, { behavior: 'allow', updatedInput: { command: 'ls' } })
  assert.equal(await a.wait(ap.approval_id, 0), undefined, '渡したら消える')
  assert.equal(a.answer(ap.approval_id, { behavior: 'deny' }), false)
  assert.deepEqual(a.snapshot(), {})
})

test('drop はそのエンティティの答え待ちを deny で片付ける。revKey は答え待ちの集合で変わる', async () => {
  const a = new Approvals()
  const x = a.ask('S@r', 'Bash', { command: 'a' }, '')
  a.ask('T@r', 'Bash', { command: 'b' }, '')
  const k1 = a.revKey()
  const waiting = a.wait(x.approval_id, 5_000)
  assert.equal(a.drop('S@r'), 1)
  assert.equal((await waiting)?.behavior, 'deny')
  assert.deepEqual(Object.keys(a.snapshot()), ['T@r'])
  assert.notEqual(a.revKey(), k1)
})

test('取りに来なくなったものは sweep で捨てる', () => {
  let now = 1_000_000
  const a = new Approvals(() => now)
  const x = a.ask('S@r', 'Bash', { command: 'a' }, '')
  now += 60_000
  assert.equal(a.snapshot()['S@r']?.length, 1, '60 秒なら残る')
  now += 60_000
  assert.equal(a.snapshot()['S@r'], undefined, '90 秒を超えたら CLI はもういない')
  assert.equal(a.get(x.approval_id), undefined)
})
