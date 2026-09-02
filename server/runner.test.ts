import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ProcessRunner } from './runner.ts'

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))

test('ProcessRunner は起動から exit までを snapshot に出し、exit で消す', async () => {
  const runner = new ProcessRunner(null)
  // node 自身を子プロセスにする（PATH に依らず必ずある）。300ms 生きて exit する
  const cmd = { bin: process.execPath, args: ['-e', 'setTimeout(() => {}, 300)'], cwd: process.cwd(), text: 'やって' }
  const before = Date.now()
  await runner.start('A@r', cmd)
  assert.equal(runner.running('A@r'), true)
  const snap = runner.snapshot()
  assert.equal(snap['A@r']?.text, 'やって')
  const since = Date.parse(snap['A@r']?.since ?? '')
  assert.ok(since >= before - 1000 && since <= Date.now() + 1000, 'since は起動時刻')
  assert.deepEqual(Object.keys(runner.snapshot()), ['A@r'])

  for (let i = 0; i < 50 && runner.running('A@r'); i++) await wait(50)
  assert.equal(runner.running('A@r'), false, 'exit で消える')
  assert.deepEqual(runner.snapshot(), {})
})

test('ProcessRunner は起動できなければ reject して何も残さない', async () => {
  const runner = new ProcessRunner(null)
  await assert.rejects(runner.start('B@r', { bin: '/nonexistent/sai-no-such-bin', args: [], cwd: process.cwd(), text: 'x' }))
  assert.equal(runner.running('B@r'), false)
  assert.deepEqual(runner.snapshot(), {})
})
