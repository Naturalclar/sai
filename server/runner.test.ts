import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isAlive, ProcessRunner } from './runner.ts'

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))
/** 300ms 生きて exit する子。node 自身を使う（PATH に依らず必ずある） */
const shortLived = { bin: process.execPath, args: ['-e', 'setTimeout(() => {}, 300)'], cwd: process.cwd(), text: 'やって' }
const readState = async (path: string) => JSON.parse(await readFile(path, 'utf-8')) as Record<string, { pid: number; since: string; text: string }>

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

test('isAlive: 自分は生きている、居ない pid は死んでいる、0 以下は spawn 待ちとして生きている扱い', () => {
  assert.equal(isAlive(process.pid), true)
  assert.equal(isAlive(2 ** 22 - 1), false, 'まず使われない大きな pid')
  assert.equal(isAlive(0), true)
  assert.equal(isAlive(-1), true)
})

test('ProcessRunner は処理中を replying.json に書き、exit で消す', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sai-runner-'))
  try {
    const state = join(dir, 'sub', 'replying.json')
    const runner = new ProcessRunner(null, state)
    await runner.start('A@r', shortLived)
    const written = await readState(state)
    assert.deepEqual(Object.keys(written), ['A@r'])
    assert.ok(written['A@r']!.pid > 0, 'spawn したら pid が入る')
    assert.equal(written['A@r']!.text, 'やって')
    assert.equal('pid' in (runner.snapshot()['A@r'] ?? {}), false, '画面に出す snapshot には pid を載せない')
    for (let i = 0; i < 50 && runner.running('A@r'); i++) await wait(50)
    assert.deepEqual(await readState(state), {}, 'exit で消える')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('ProcessRunner は起動時に replying.json から生きている pid の分だけ引き取り、死んだら落とす', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sai-runner-'))
  // 前のサーバが起動した子のつもり。detached で 10 秒生きる
  const survivor = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 10000)'], { detached: true, stdio: 'ignore' })
  survivor.unref()
  // もう死んでいる子のつもり
  const dead = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' })
  await new Promise<void>((r) => dead.once('exit', () => r()))
  try {
    const state = join(dir, 'replying.json')
    await writeFile(
      state,
      JSON.stringify({
        'live@r': { pid: survivor.pid, since: '2026-09-04T04:11:33.000Z', text: '95着手して' },
        'dead@r': { pid: dead.pid, since: '2026-09-04T04:00:00.000Z', text: 'x' },
        'junk@r': { pid: 'not a pid' },
        'zero@r': { pid: 0, since: '2026-09-04T04:00:00.000Z', text: 'x' },
      }),
    )
    const runner = new ProcessRunner(null, state)
    assert.equal(runner.running('live@r'), true, '生きている pid は引き取る')
    assert.equal(runner.running('dead@r'), false, '死んだ pid は捨てる')
    assert.equal(runner.running('junk@r'), false)
    assert.equal(runner.running('zero@r'), false, 'pid 0 のまま残った行（spawn 前に落ちた）は捨てる')
    assert.deepEqual(runner.snapshot(), { 'live@r': { since: '2026-09-04T04:11:33.000Z', text: '95着手して' } })
    assert.deepEqual(Object.keys(await readState(state)), ['live@r'], '落とした形で書き直す')

    // 引き取った子が死んだら、見たときに落ちる
    survivor.kill('SIGKILL')
    for (let i = 0; i < 50 && isAlive(survivor.pid!); i++) await wait(50)
    assert.equal(runner.running('live@r'), false)
    assert.deepEqual(runner.snapshot(), {})
    assert.deepEqual(await readState(state), {})
  } finally {
    if (!survivor.killed) survivor.kill('SIGKILL')
    await rm(dir, { recursive: true, force: true })
  }
})

test('ProcessRunner は replying.json が無い・壊れていても起動する', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sai-runner-'))
  try {
    assert.deepEqual(new ProcessRunner(null, join(dir, 'none.json')).snapshot(), {})
    const broken = join(dir, 'broken.json')
    await writeFile(broken, '{ not json')
    assert.deepEqual(new ProcessRunner(null, broken).snapshot(), {})
    await writeFile(broken, '[1,2]')
    assert.deepEqual(new ProcessRunner(null, broken).snapshot(), {})
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
