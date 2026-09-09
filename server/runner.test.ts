import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { childEnv, failureOf, isAlive, ProcessRunner, tailFrom } from './runner.ts'

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
  // 別プロセスの返信には via を付けない（端末に打ち込んだ分だけ 'terminal'。要対応の出し分け。#232）
  assert.equal(snap['A@r']?.via, undefined)
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

test('childEnv: TMUX_PANE だけ落とし、TMUX と他はそのまま。元の環境は触らない（#234）', () => {
  const env = { PATH: '/usr/bin', TMUX_PANE: '%249', TMUX: '/tmp/tmux-501/default,2050,13', SAI_CLAUDE_BIN: 'claude' }
  const next = childEnv(env)
  assert.equal(next.TMUX_PANE, undefined, 'サーバのペインを継がせない')
  assert.equal(next.TMUX, '/tmp/tmux-501/default,2050,13', 'ターンの中で tmux を使うことはあるので、tmux ごと隠さない')
  assert.equal(next.PATH, '/usr/bin')
  assert.equal(next.SAI_CLAUDE_BIN, 'claude')
  assert.equal(env.TMUX_PANE, '%249', '渡された環境は書き換えない')
  assert.equal(childEnv({ PATH: '/usr/bin' }).TMUX_PANE, undefined, '元から無くても落ちない')
})

test('ProcessRunner が起動した子に TMUX_PANE が渡らない（record.py がサーバのペインを書かない。#234）', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sai-runner-'))
  const before = process.env.TMUX_PANE
  try {
    // サーバが tmux のペインで動いている状況を作る
    process.env.TMUX_PANE = '%249'
    const out = join(dir, 'seen.txt')
    const runner = new ProcessRunner(null)
    // 子から見た TMUX_PANE を書き出す。record.py が読むのと同じ環境変数
    const code = `require('fs').writeFileSync(${JSON.stringify(out)}, String(process.env.TMUX_PANE ?? '(unset)'))`
    await runner.start('T@r', { bin: process.execPath, args: ['-e', code], cwd: process.cwd(), text: 'x' })
    for (let i = 0; i < 50 && runner.running('T@r'); i++) await wait(20)
    assert.equal(await readFile(out, 'utf-8'), '(unset)')
  } finally {
    if (before === undefined) delete process.env.TMUX_PANE
    else process.env.TMUX_PANE = before
    await rm(dir, { recursive: true, force: true })
  }
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

test('tailFrom: offset 以降の末尾を数行だけ返す。読めなければ空', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sai-tail-'))
  const log = join(dir, 'reply.log')
  await writeFile(log, '--- 見出し\n1行目\n2行目\n3行目\n4行目\n')
  assert.equal(tailFrom(log, 0), '2行目 / 3行目 / 4行目', '末尾 3 行')
  const offset = '--- 見出し\n1行目\n'.length * 3 // 日本語なので UTF-8 で 3 倍
  assert.equal(tailFrom(log, offset).includes('見出し'), false, 'offset より前は読まない')
  assert.equal(tailFrom(join(dir, 'nope.log'), 0), '', '無いファイル')
  await rm(dir, { recursive: true, force: true })
})

test('failureOf: 0 は失敗ではない。非0はコード、シグナルは -1', () => {
  assert.equal(failureOf(0, null, null, 0), null)
  assert.equal(failureOf(null, null, null, 0), null, 'コードもシグナルも無ければ失敗にしない')
  assert.deepEqual(failureOf(3, null, null, 0), { code: 3, tail: '' })
  const bySignal = failureOf(null, 'SIGTERM', null, 0)
  assert.equal(bySignal?.code, -1)
  assert.match(bySignal?.tail ?? '', /SIGTERM/)
})

test('ProcessRunner は非0で終わった返信を、理由つきで少しの間だけ残す（#172）', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sai-fail-'))
  const log = join(dir, 'reply.log')
  const runner = new ProcessRunner(log)
  // stderr に理由を書いて 3 で終わる子
  await runner.start('F@r', {
    bin: process.execPath,
    args: ['-e', 'console.error("thread-store conflict: already has an active writer"); process.exit(3)'],
    cwd: process.cwd(),
    text: '着手して',
  })
  for (let i = 0; i < 60 && runner.running('F@r'); i++) await wait(50)

  assert.equal(runner.running('F@r'), false, '失敗した分は「処理中」ではない（次の返信を止めない）')
  const failed = runner.snapshot()['F@r']
  assert.equal(failed?.text, '着手して')
  assert.equal(failed?.failed?.code, 3)
  assert.match(failed?.failed?.tail ?? '', /active writer/, 'reply.log の末尾が理由になる')
  await rm(dir, { recursive: true, force: true })
})

test('ProcessRunner は 0 で終わった返信を残さない', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sai-ok-'))
  const runner = new ProcessRunner(join(dir, 'reply.log'))
  await runner.start('S@r', { bin: process.execPath, args: ['-e', 'process.exit(0)'], cwd: process.cwd(), text: 'やって' })
  for (let i = 0; i < 60 && Object.keys(runner.snapshot()).length > 0; i++) await wait(50)
  assert.deepEqual(runner.snapshot(), {}, '成功したら消える')
  await rm(dir, { recursive: true, force: true })
})

test('失敗した分は replying.json に書かない（引き取ると死んだ pid が残る）', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sai-failstate-'))
  const state = join(dir, 'replying.json')
  const runner = new ProcessRunner(join(dir, 'reply.log'), state)
  await runner.start('F@r', { bin: process.execPath, args: ['-e', 'process.exit(4)'], cwd: process.cwd(), text: 'x' })
  for (let i = 0; i < 60 && runner.running('F@r'); i++) await wait(50)
  assert.equal(runner.snapshot()['F@r']?.failed?.code, 4)
  assert.deepEqual(await readState(state), {}, '失敗の分は書かない')
  await rm(dir, { recursive: true, force: true })
})
