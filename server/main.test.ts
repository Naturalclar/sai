import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { Agent, createServer, request } from 'node:http'
import { connect } from 'node:net'
import type { Socket } from 'node:net'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expandHome, main, parseOptions, shutdown } from './main.ts'

const ok = (argv: string[], env: NodeJS.ProcessEnv = {}) => {
  const r = parseOptions(argv, env)
  assert.equal(r.ok, true, JSON.stringify(r))
  return r.ok ? r.options : (undefined as never)
}
const bad = (argv: string[], env: NodeJS.ProcessEnv = {}) => {
  const r = parseOptions(argv, env)
  assert.equal(r.ok, false, JSON.stringify(r))
  return r.ok ? '' : r.error
}

test('parseOptions: 既定と環境変数', () => {
  assert.deepEqual(ok([]), { port: 8787, host: '127.0.0.1', feedDir: join(homedir(), '.agent-feed') })
  assert.equal(ok([], { SAI_PORT: '9000' }).port, 9000)
  assert.equal(ok([], { AGENT_FEED_DIR: '/tmp/feed' }).feedDir, '/tmp/feed')
  assert.equal(ok(['--port', '9001'], { SAI_PORT: '9000' }).port, 9001, '引数が環境変数に勝つ')
  assert.equal(ok(['--feed-dir', '~/x']).feedDir, join(homedir(), 'x'))
  assert.equal(ok(['--host', 'localhost']).host, 'localhost')
})

test('parseOptions: 先頭の -- は落とす（pnpm start -- --port 9000）', () => {
  assert.equal(ok(['--', '--port', '18790', '--feed-dir', '/tmp/x']).port, 18790)
  assert.equal(ok(['--']).port, 8787)
})

test('parseOptions: ポートの検査は引数でも環境変数でも同じ', () => {
  for (const v of ['abc', '0', '65536', '12x', '1.5', '']) {
    assert.match(bad(['--port', v]), /invalid port/, `--port ${v}`)
    assert.match(bad([], { SAI_PORT: v }), /invalid port/, `SAI_PORT=${v}`)
  }
  assert.match(bad([], { SAI_PORT: '-1' }), /invalid port/)
  // `--port -1` は parseArgs が -1 をオプションと見るので文は違うが、同じく1行で断る
  assert.match(bad(['--port', '-1']), /-1|argument missing|usage/)
  assert.equal(ok(['--port', '65535']).port, 65535)
  assert.equal(ok(['--port', '1']).port, 1)
})

test('parseOptions: 外向きの host と知らない引数は1行で断る', () => {
  assert.match(bad(['--host', '0.0.0.0']), /refusing to bind to 0\.0\.0\.0/)
  assert.match(bad(['--nope']), /Unknown option '--nope'[\s\S]*usage: pnpm start/)
  assert.match(bad(['extra']), /Unexpected argument 'extra'[\s\S]*usage: pnpm start/)
  assert.match(bad(['--', '--', '--port', '1']), /Unexpected argument[\s\S]*usage/, '-- は1つだけ落とす')
})

test('main: おかしい引数では例外ではなく exit 2 で、理由を stderr に1行出す', () => {
  const origExit = process.exit
  const origError = console.error
  const errors: string[] = []
  let code: number | undefined
  // process.exit は戻らない前提のコードなので、差し替えでは例外で抜ける
  process.exit = ((c?: number) => {
    code = c
    throw new Error('exit')
  }) as typeof process.exit
  console.error = (...args: unknown[]) => errors.push(args.map(String).join(' '))
  try {
    assert.throws(() => main(['--port', 'abc']), /^Error: exit$/)
    assert.equal(code, 2)
    assert.equal(errors.length, 1)
    assert.match(errors[0]!, /invalid port: abc/)
    assert.doesNotMatch(errors[0]!, /at .*main\.ts/, 'スタックトレースは出さない')
  } finally {
    process.exit = origExit
    console.error = origError
  }
})

/** close のコールバックを持っておく偽のサーバ（本物は接続が全部閉じるまで呼ばない） */
function fakeServer() {
  const calls: string[] = []
  let done: (() => void) | undefined
  return {
    calls,
    /** 接続が全部閉じた、を起こす */
    drained: () => done?.(),
    close: (cb?: () => void) => {
      calls.push('close')
      done = cb
    },
    closeIdleConnections: () => void calls.push('closeIdle'),
    closeAllConnections: () => void calls.push('closeAll'),
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

test('shutdown: 接続が残っていても、切って終わる（#296）', async () => {
  const server = fakeServer()
  const exits: number[] = []
  const stop = shutdown(server, { exit: (c) => void exits.push(c), closeAllMs: 5, forceExitMs: 30 })

  stop()
  assert.deepEqual(server.calls, ['close', 'closeIdle'], 'まず受け付けを止め、アイドルな接続を閉じる')
  assert.deepEqual(exits, [], 'close のコールバックが来るまでは終わらない')

  await sleep(60)
  assert.deepEqual(server.calls, ['close', 'closeIdle', 'closeAll'], '残った接続は closeAllConnections で切る')
  assert.deepEqual(exits, [0], '抜けられなくても保険のタイマーで終わる')
})

test('shutdown: 接続が全部閉じればその場で終わる', () => {
  const server = fakeServer()
  const exits: number[] = []
  const stop = shutdown(server, { exit: (c) => void exits.push(c), closeAllMs: 10_000, forceExitMs: 10_000 })
  stop()
  server.drained()
  assert.deepEqual(exits, [0])
})

test('shutdown: 2 回目の C-c はすぐ終わる', () => {
  const server = fakeServer()
  const exits: number[] = []
  const stop = shutdown(server, { exit: (c) => void exits.push(c), closeAllMs: 10_000, forceExitMs: 10_000 })
  stop()
  assert.deepEqual(exits, [], '1 回目は接続を閉じるのを待つ')
  stop()
  assert.deepEqual(exits, [0], '2 回目は待たない')
  assert.deepEqual(server.calls, ['close', 'closeIdle'], '2 回目に close をもう一度呼んでも意味が無い')
})

test('shutdown: SAI が起こした子を、1 回目の C-c の頭で 1 度だけ落とす（#457）', () => {
  const server = fakeServer()
  const exits: number[] = []
  let disposed = 0
  const stop = shutdown(server, { exit: (c) => void exits.push(c), closeAllMs: 10_000, forceExitMs: 10_000, onStop: () => void disposed++ })
  stop()
  assert.equal(disposed, 1, '接続が閉じるのを待つ前に落とす（`FORCE_EXIT_MS` で諦める筋でも通るように）')
  assert.deepEqual(server.calls, ['close', 'closeIdle'])
  stop()
  assert.equal(disposed, 1, '2 回目の C-c では呼ばない')
  assert.deepEqual(exits, [0])
})

test('shutdown: 子を落とせなくても SAI 自身は終わる（#457）', () => {
  const server = fakeServer()
  const exits: number[] = []
  const stop = shutdown(server, { exit: (c) => void exits.push(c), closeAllMs: 10_000, forceExitMs: 10_000, onStop: () => { throw new Error('kill EPERM') } })
  stop()
  assert.deepEqual(server.calls, ['close', 'closeIdle'], '投げても受け付けは止める')
  server.drained()
  assert.deepEqual(exits, [0])
})

const MAIN = fileURLToPath(new URL('./main.ts', import.meta.url))
/** C-c を送ってから終わるまでに待つ上限。直す前のコードはここを超える（接続が閉じるまで抜けない） */
const EXIT_WAIT_MS = 6_000

/** 使えるポートを 1 つ借りて、すぐ返す */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer()
    s.listen(0, '127.0.0.1', () => {
      const addr = s.address()
      const port = typeof addr === 'object' && addr ? addr.port : 0
      s.close(() => (port ? resolve(port) : reject(new Error('ポートが取れない'))))
    })
  })
}

/** 起動の 1 行（`SAI  http://…`）が stderr に出るまで待つ */
function waitForStart(child: ChildProcess): Promise<void> {
  return new Promise((resolve, reject) => {
    let out = ''
    const timer = setTimeout(() => reject(new Error(`起動しない: ${out}`)), 20_000)
    child.stderr?.on('data', (b: Buffer) => {
      out += b.toString('utf-8')
      if (out.includes('SAI  http://')) {
        clearTimeout(timer)
        resolve()
      }
    })
    child.on('exit', (code) => {
      clearTimeout(timer)
      reject(new Error(`起動せずに終わった (${code}): ${out}`))
    })
  })
}

/** 生の TCP を 1 本つなぐ（HTTP のやり取りはしない） */
function open(port: number): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const s = connect(port, '127.0.0.1')
    s.on('connect', () => resolve(s))
    s.on('error', reject)
  })
}

function get(url: string, agent: Agent): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = request(url, { agent }, (res) => {
      res.resume()
      res.on('end', () => resolve())
    })
    req.on('error', reject)
    req.end()
  })
}

/**
 * 開いたままの接続を残して C-c を送り、終わるまでを見る（#296）。
 *
 * **残すのは「リクエストを最後まで送っていない接続」**。直す前のコードで実測したところ、
 * ポーリングする keep-alive も、叩いたあとアイドルにした keep-alive も `server.close()` が自分で切って
 * 3ms で終わったが、**つないだだけの接続（ブラウザの先読み）と途中まで送った接続は 12 秒経っても終わらなかった**。
 * close のコールバックはこれが閉じるまで来ないので、listen だけ消えて node は生き続ける。
 */
test('main: 開いたままの接続があっても、C-c で終わる（#296）', async () => {
  const feedDir = mkdtempSync(join(tmpdir(), 'sai-main-'))
  const port = await freePort()
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', MAIN, '--port', String(port), '--feed-dir', feedDir], {
    stdio: ['ignore', 'ignore', 'pipe'],
  })
  const exited = new Promise<number | null>((resolve) => child.on('exit', (code) => resolve(code)))
  // 画面と同じ keep-alive の接続を 1 本、ポーリングさせたまま保つ
  const agent = new Agent({ keepAlive: true, maxSockets: 1 })
  const url = `http://127.0.0.1:${port}/api/sessions?days=1`
  const held: Socket[] = []
  let poll: NodeJS.Timeout | undefined
  try {
    await waitForStart(child)
    await get(url, agent)
    poll = setInterval(() => void get(url, agent).catch(() => {}), 200)
    // つないだだけの接続と、途中まで送った接続
    held.push(await open(port))
    const partial = await open(port)
    partial.write('GET /api/sessions?days=1 HTTP/1.1\r\nHost: 127.0.0.1\r\n')
    held.push(partial)

    child.kill('SIGINT')
    const code = await Promise.race([exited, sleep(EXIT_WAIT_MS).then(() => 'まだ終わらない' as const)])
    assert.equal(code, 0, `C-c から ${EXIT_WAIT_MS}ms 以内に終わること`)
  } finally {
    if (poll) clearInterval(poll)
    agent.destroy()
    for (const s of held) s.destroy()
    child.kill('SIGKILL')
    rmSync(feedDir, { recursive: true, force: true })
  }
})

test('expandHome', () => {
  assert.equal(expandHome('~'), homedir())
  assert.equal(expandHome('~/a'), join(homedir(), 'a'))
  assert.equal(expandHome('/abs'), '/abs')
  assert.equal(expandHome('~user/x'), '~user/x')
})
