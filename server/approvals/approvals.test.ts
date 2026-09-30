import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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

test('persistTo: 立て直すと、まだ回っている返信のものだけ引き取る。答え済みで渡していないものも残す（#440）', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sai-approvals-'))
  const path = join(dir, 'approvals.json')
  try {
    const before = new Approvals()
    before.persistTo(path, () => true)
    const alive = before.ask('ALIVE@r', 'Bash', { command: 'ls' }, 't1')
    const gone = before.ask('GONE@r', 'Bash', { command: 'rm x' }, 't2')
    const answered = before.ask('ALIVE@r', 'Bash', { command: 'pwd' }, 't3')
    before.answer(answered.approval_id, { behavior: 'allow', updatedInput: { command: 'pwd' } })
    assert.match(await readFile(path, 'utf-8'), /rm x/, '預けた時点で書く')

    // 立て直し: 返信の子が生きているのは ALIVE@r だけ（replying.json から引き取れた分）
    const after = new Approvals()
    after.persistTo(path, (id) => id === 'ALIVE@r')
    assert.deepEqual(after.snapshot()['ALIVE@r']?.map((a) => a.approval_id), [alive.approval_id], '答え待ちとして画面に出る')
    assert.equal(after.get(gone.approval_id), undefined, '子が居ないものは捨てる（答えても届け先が無い）')
    assert.deepEqual(await after.wait(answered.approval_id, 0), { behavior: 'allow', updatedInput: { command: 'pwd' } }, '押したのにまだ CLI に渡していない答えは、繋ぎ直した MCP が受け取れる')
    assert.equal(after.answer(alive.approval_id, { behavior: 'deny', message: 'no' }), true, '引き取ったものに答えられる')
    assert.doesNotMatch(await readFile(path, 'utf-8'), /rm x/, '捨てた分は書き直したファイルからも消える')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
