// daemon を読むだけで見る口（#848）。一時の unix ソケットに偽のサーバを立てる。本物の daemon・本物の codex は使わない
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:net'
import type { Server, Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CodexDaemonClient, DAEMON_METHODS, daemonGap, daemonOccupied, daemonSocketPath, threadState } from './codexDaemon.ts'
import { acceptKey, connectUnixWebSocket, encodeFrame } from './unixWebSocket.ts'

let dir: string
const clients: CodexDaemonClient[] = []
const fakes: FakeDaemon[] = []
const daemonClient = (opts: ConstructorParameters<typeof CodexDaemonClient>[0]) => {
  const c = new CodexDaemonClient(opts)
  clients.push(c)
  return c
}
before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'sai-daemon-'))
})
after(async () => {
  // テストが途中で落ちても、繋いだままプロセスが残らないように
  for (const c of clients) c.stop()
  await Promise.all(fakes.map((f) => f.close()))
  await rm(dir, { recursive: true, force: true })
})

const wait = async (ok: () => boolean, ms = 2000) => {
  const end = Date.now() + ms
  while (!ok() && Date.now() < end) await new Promise((r) => setTimeout(r, 5))
  assert.ok(ok(), '待ち切れなかった')
}

/** サーバからのフレーム（マスクしない） */
const serverFrame = (op: number, text: string, fin = true) => {
  const body = Buffer.from(text)
  assert.ok(body.length < 126)
  return Buffer.concat([Buffer.from([(fin ? 0x80 : 0) | op, body.length]), body])
}

/** 客からのフレームを読む（マスクを外す） */
function readFrames(buf: Buffer): { frames: { op: number; text: string }[]; rest: Buffer } {
  const frames: { op: number; text: string }[] = []
  let at = 0
  for (;;) {
    if (buf.length < at + 2) break
    const op = buf[at]! & 15
    let n = buf[at + 1]! & 127
    let o = at + 2
    if (n === 126) {
      n = buf.readUInt16BE(at + 2)
      o = at + 4
    }
    assert.ok(buf[at + 1]! & 0x80, '客のフレームはマスクする')
    if (buf.length < o + 4 + n) break
    const mask = buf.subarray(o, o + 4)
    const body = Buffer.from(buf.subarray(o + 4, o + 4 + n))
    for (let i = 0; i < body.length; i++) body[i]! ^= mask[i % 4]!
    frames.push({ op, text: body.toString() })
    at = o + 4 + n
  }
  return { frames, rest: buf.subarray(at) }
}

/** 偽の daemon。受けた要求を覚え、決まった答えを返す */
class FakeDaemon {
  server: Server
  sent: { id?: number; method?: string; result?: unknown }[] = []
  pongs: string[] = []
  clients = new Set<Socket>()
  threads: { id: string; status: unknown }[] = []
  path: string
  constructor(path: string) {
    this.path = path
    fakes.push(this)
    this.server = createServer((socket) => {
      this.clients.add(socket)
      socket.on('close', () => this.clients.delete(socket))
      socket.on('error', () => {})
      let buf: Buffer = Buffer.alloc(0)
      let upgraded = false
      socket.on('data', (d) => {
        buf = Buffer.concat([buf, d])
        if (!upgraded) {
          const end = buf.indexOf('\r\n\r\n')
          if (end < 0) return
          const key = /sec-websocket-key: (.+)/i.exec(buf.subarray(0, end).toString())![1]!.trim()
          socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${this.accept(key)}\r\n\r\n`)
          upgraded = true
          buf = buf.subarray(end + 4)
        }
        const { frames, rest } = readFrames(buf)
        buf = rest
        for (const f of frames) {
          if (f.op === 10) this.pongs.push(f.text)
          if (f.op !== 1) continue
          const m = JSON.parse(f.text) as { id?: number; method?: string }
          this.sent.push(m)
          if (m.id === undefined || !m.method) continue
          const result = m.method === 'thread/list' ? { data: this.threads } : m.method === 'thread/loaded/list' ? { data: this.threads.map((t) => t.id) } : {}
          this.push({ id: m.id, result })
        }
      })
    })
  }
  accept(key: string) {
    return acceptKey(key)
  }
  listen() {
    return new Promise<void>((resolve) => this.server.listen(this.path, resolve))
  }
  push(message: unknown) {
    const body = Buffer.from(JSON.stringify(message))
    const head = body.length < 126 ? Buffer.from([0x81, body.length]) : Buffer.from([0x81, 126, body.length >> 8, body.length & 255])
    for (const c of this.clients) c.write(Buffer.concat([head, body]))
  }
  raw(frame: Buffer) {
    for (const c of this.clients) c.write(frame)
  }
  close() {
    for (const c of this.clients) c.destroy()
    return new Promise<void>((resolve) => (this.server.listening ? this.server.close(() => resolve()) : resolve()))
  }
}

let n = 0
const sockPath = () => join(dir, `s${++n}.sock`)

test('送るのは許可一覧の要求と initialized だけで、繋いだら thread/list の状態を覚える。通知で動き、idle も覚える（#848）', async () => {
  const fake = new FakeDaemon(sockPath())
  fake.threads = [
    { id: 'A', status: { type: 'active', activeFlags: [] } },
    { id: 'B', status: { type: 'idle' } },
    { id: 'C', status: { type: 'active', activeFlags: ['waitingOnApproval'] } },
  ]
  await fake.listen()
  const c = daemonClient({ socketPath: fake.path })
  assert.equal(c.link(), 'off')
  c.setEnabled(true)
  await wait(() => c.link() === 'connected')
  assert.deepEqual([c.state('A'), c.state('B'), c.state('C'), c.state('D')], ['active', 'idle', 'waiting', undefined])

  fake.push({ method: 'thread/status/changed', params: { threadId: 'B', status: { type: 'active', activeFlags: ['waitingOnUserInput'] } } })
  fake.push({ method: 'thread/status/changed', params: { threadId: 'A', status: { type: 'idle' } } })
  fake.push({ method: 'thread/started', params: { thread: { id: 'D', status: { type: 'active', activeFlags: [] } } } })
  await wait(() => c.state('D') === 'active')
  assert.deepEqual([c.state('A'), c.state('B')], ['idle', 'waiting'])

  // **サーバからの要求には答えない**
  const sentBefore = fake.sent.length
  fake.push({ id: 900, method: 'item/commandExecution/requestApproval', params: { threadId: 'A' } })
  fake.push({ method: 'thread/status/changed', params: { threadId: 'A', status: { type: 'active', activeFlags: [] } } })
  await wait(() => c.state('A') === 'active')
  assert.equal(fake.sent.length, sentBefore, '答えない')

  const methods = fake.sent.map((m) => m.method)
  assert.deepEqual(methods, ['initialize', 'initialized', 'thread/list', 'thread/loaded/list'])
  for (const m of methods) assert.ok(m === 'initialized' || (DAEMON_METHODS as readonly string[]).includes(m!), m)
  c.stop()
  assert.equal(c.link(), 'off')
  assert.equal(c.state('A'), undefined, '切ったら忘れる')
  await fake.close()
})

test('thread/list を待つ間に届いた通知を上書きしない。形の違う文字列では落ちない（#848 のレビュー）', async () => {
  const fake = new FakeDaemon(sockPath())
  fake.threads = [
    { id: 'A', status: { type: 'active', activeFlags: [] } },
    { id: 'G', status: { type: 'active', activeFlags: [] } },
  ]
  await fake.listen()
  const push = fake.push.bind(fake)
  fake.push = (m) => {
    const r = (m as { result?: { data?: unknown[] } }).result
    if (r?.data?.[0] && typeof r.data[0] === 'object') {
      push({ method: 'thread/status/changed', params: { threadId: 'A', status: { type: 'idle' } } })
      push({ method: 'thread/status/changed', params: { threadId: 'G', status: { type: 'notLoaded' } } })
    }
    push(m)
  }
  const c = daemonClient({ socketPath: fake.path })
  c.setEnabled(true)
  await wait(() => c.link() === 'connected')
  assert.equal(c.state('A'), 'idle')
  assert.equal(c.state('G'), undefined, '分からないになった通知も、古い一覧で戻さない')
  fake.raw(serverFrame(1, 'null'))
  fake.raw(serverFrame(1, '1'))
  fake.raw(serverFrame(1, '[]'))
  fake.push({ method: 'thread/status/changed', params: { threadId: 'A', status: { type: 'active', activeFlags: [] } } })
  await wait(() => c.state('A') === 'active')
  c.stop()
  await fake.close()
})

test('許可一覧は読む要求だけ（書く要求を足すならこのテストを直す）', () => {
  assert.deepEqual([...DAEMON_METHODS], ['initialize', 'thread/list', 'thread/loaded/list'])
})

test('切のままなら繋がない。ソケットが無ければ no_socket で、できたら繋ぐ。切れたら忘れて繋ぎ直す（#848）', async () => {
  const path = sockPath()
  const c = daemonClient({ socketPath: path, retryMs: 10 })
  c.setEnabled(true)
  assert.equal(c.link(), 'no_socket')
  await new Promise((r) => setTimeout(r, 40))
  assert.equal(c.link(), 'no_socket', 'daemon を起こさない')

  const fake = new FakeDaemon(path)
  fake.threads = [{ id: 'A', status: { type: 'active', activeFlags: [] } }]
  await fake.listen()
  await wait(() => c.link() === 'connected')
  assert.equal(c.state('A'), 'active')

  await fake.close()
  await wait(() => c.link() !== 'connected')
  assert.equal(c.state('A'), undefined, '切れている間の状態は分からない')

  const again = new FakeDaemon(path)
  again.threads = [{ id: 'A', status: { type: 'idle' } }]
  await again.listen()
  await wait(() => c.link() === 'connected')
  assert.equal(c.state('A'), 'idle')
  c.stop()
  await again.close()

  const fake3 = new FakeDaemon(sockPath())
  await fake3.listen()
  const off = daemonClient({ socketPath: fake3.path, retryMs: 10 })
  off.setEnabled(false)
  await new Promise((r) => setTimeout(r, 30))
  assert.equal(fake3.sent.length, 0, '切なら繋がない')
  off.stop()
  await fake3.close()
})

test('thread/list が失敗したら failed にして切る（繋がった扱いにしない）', async () => {
  const fake = new FakeDaemon(sockPath())
  await fake.listen()
  const push = fake.push.bind(fake)
  fake.push = (m) => push((m as { result?: { data?: unknown } }).result?.data ? { id: (m as { id: number }).id, error: { message: 'no' } } : m)
  const c = daemonClient({ socketPath: fake.path, retryMs: 60_000 })
  c.setEnabled(true)
  await wait(() => c.link() === 'failed')
  c.stop()
  await fake.close()
})

test('unixWebSocket: 受け手が投げても落ちず、次のメッセージを読む（#848 のレビュー）', async () => {
  const fake = new FakeDaemon(sockPath())
  await fake.listen()
  const got: string[] = []
  const ws = await connectUnixWebSocket(fake.path, {
    text: (t) => {
      if (t === 'bad') throw new Error('boom')
      got.push(t)
    },
    close: () => {},
  })
  fake.raw(serverFrame(1, 'bad'))
  fake.raw(serverFrame(1, 'good'))
  await wait(() => got.length === 1)
  assert.deepEqual(got, ['good'])
  ws.close()
  await fake.close()
})

test('unixWebSocket: ping に pong を返し、分割されたテキストをつなぐ。Accept が違えば繋がない', async () => {
  const fake = new FakeDaemon(sockPath())
  await fake.listen()
  const got: string[] = []
  const ws = await connectUnixWebSocket(fake.path, { text: (t) => got.push(t), close: () => {} })
  fake.raw(serverFrame(9, 'hi'))
  fake.raw(serverFrame(1, '前半', false))
  fake.raw(serverFrame(0, '後半'))
  await wait(() => got.length === 1 && fake.pongs.length === 1)
  assert.deepEqual(got, ['前半後半'])
  assert.deepEqual(fake.pongs, ['hi'])
  ws.close()
  await fake.close()

  const bad = new FakeDaemon(sockPath())
  bad.accept = () => createHash('sha1').update('x').digest('base64')
  await bad.listen()
  await assert.rejects(connectUnixWebSocket(bad.path, { text: () => {}, close: () => {} }), /handshake refused/)
  await bad.close()
})

test('encodeFrame: 長さの 3 つの形とマスク', () => {
  for (const size of [5, 300]) {
    const { frames, rest } = readFrames(encodeFrame(1, Buffer.from('a'.repeat(size))))
    assert.deepEqual(frames, [{ op: 1, text: 'a'.repeat(size) }])
    assert.equal(rest.length, 0)
  }
  assert.equal(encodeFrame(1, Buffer.alloc(70000))[1]! & 127, 127)
})

test('daemonOccupied: 言えるのは空きでないときだけ。idle と分からないは空文字（#848）', () => {
  assert.equal(daemonOccupied('active'), 'busy')
  assert.equal(daemonOccupied('waiting'), 'waiting')
  assert.equal(daemonOccupied('idle'), '')
  assert.equal(daemonOccupied(undefined), '')
})

test('threadState / daemonGap / daemonSocketPath', () => {
  assert.equal(threadState({ type: 'notLoaded' }), undefined, 'daemon の外で回っているスレッドもこの形に見えるので分からない扱い')
  assert.equal(threadState({ type: 'systemError' }), undefined, '知らない形は分からない')
  assert.equal(threadState(null), undefined)
  assert.equal(daemonGap('', 'active'), 'daemon_only')
  assert.equal(daemonGap('', 'waiting'), 'daemon_only')
  assert.equal(daemonGap('busy', 'active'), '')
  assert.equal(daemonGap('terminal', 'idle'), 'sai_only')
  assert.equal(daemonGap('queued', 'idle'), '', '預かりは daemon の知らないこと')
  assert.equal(daemonGap('busy', undefined), '')
  assert.equal(daemonSocketPath({ CODEX_HOME: '/x' }, '/h'), '/x/app-server-control/app-server-control.sock')
  assert.equal(daemonSocketPath({}, '/h'), '/h/.codex/app-server-control/app-server-control.sock')
})
