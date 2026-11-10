// daemon を読むだけで見る口（#848）。一時の unix ソケットに偽のサーバを立てる。本物の daemon・本物の codex は使わない
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:net'
import type { Server, Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CodexDaemonClient, DAEMON_ANSWERABLE, DAEMON_METHODS, DAEMON_SETTLE_MS, daemonGap, errorMessage, daemonOccupied, daemonSocketPath, threadState } from './codexDaemon.ts'
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

/** 許可を受けて画面に出すスレッドか（中の状態を見る。本番のコードはこれを使わず、預かった許可だけを見る） */
const receives = (c: CodexDaemonClient, threadId: string) => (c as unknown as { resumed: Map<string, string> }).resumed.has(threadId)

/** スレッドを待ちにして、客がそれを見るまで待つ（新しく resume するのは待っているスレッドだけ） */
const waitingOn = async (fake: FakeDaemon, c: CodexDaemonClient, threadId: string) => {
  fake.push({ method: 'thread/status/changed', params: { threadId, status: { type: 'active', activeFlags: ['waitingOnApproval'] } } })
  await wait(() => c.state(threadId) === 'waiting')
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

test('許可一覧は読む要求と thread/resume だけ。turn/* は足さない（足すならこのテストを直す。#848 の 3）', () => {
  assert.deepEqual([...DAEMON_METHODS], ['initialize', 'thread/list', 'thread/loaded/list', 'thread/resume'])
  assert.deepEqual([...DAEMON_ANSWERABLE], ['item/commandExecution/requestApproval', 'item/fileChange/requestApproval', 'item/tool/requestUserInput'])
})

const cmdRequest = (id: number | string, threadId: string, extra: object = {}) => ({
  id,
  method: 'item/commandExecution/requestApproval',
  params: { threadId, turnId: 'T1', itemId: 'I1', command: 'ls', availableDecisions: ['accept', 'decline'], ...extra },
})

test('待ちを知らせ、resume したスレッドの要求だけを預かる。自分からは答えず、押された候補だけを返す。TUI で答えられたら畳む（#848 の 3）', async () => {
  const fake = new FakeDaemon(sockPath())
  fake.threads = [
    { id: 'W', status: { type: 'active', activeFlags: ['waitingOnApproval'] } },
    { id: 'B', status: { type: 'idle' } },
  ]
  await fake.listen()
  const c = daemonClient({ socketPath: fake.path })
  const told: string[] = []
  // 確かめ直しが通る役（app.ts の代わり）。一度 resume したスレッドは、知らされるたびに通す
  const passes = new Map<string, string>()
  c.onWaiting((id) => {
    told.push(id)
    const entity = passes.get(id)
    if (entity) void c.resume(id, entity)
  })
  c.setEnabled(true)
  await wait(() => c.link() === 'connected' && told.length === 1)
  assert.deepEqual(told, ['W'], '繋ぐ前から待っていたスレッドも知らせる')
  fake.push({ method: 'thread/status/changed', params: { threadId: 'B', status: { type: 'active', activeFlags: ['waitingOnUserInput'] } } })
  await wait(() => told.length === 2)
  assert.deepEqual(told, ['W', 'B'])

  // resume していないスレッドの要求は預からない
  fake.push(cmdRequest(500, 'W'))
  await new Promise((r) => setTimeout(r, 20))
  assert.equal(await c.resume('W', 'W@r'), true)
  passes.set('W', 'W@r')
  assert.equal(receives(c, 'W'), true)
  const resume = fake.sent.find((m) => m.method === 'thread/resume') as { params?: unknown }
  assert.deepEqual(resume.params, { threadId: 'W', excludeTurns: true }, '上書きは渡さない')
  assert.deepEqual(c.snapshot(), {})

  fake.push(cmdRequest(501, 'W'))
  fake.push({ id: 502, method: 'item/permissions/requestApproval', params: { threadId: 'W', turnId: 'T1', itemId: 'I2' } })
  fake.push({ id: 503, method: 'mcpServer/elicitation/request', params: { threadId: 'W', turnId: 'T1', itemId: 'I3' } })
  fake.push(cmdRequest(501, 'W'))
  await wait(() => (c.snapshot()['W@r'] ?? []).length === 1)
  await new Promise((r) => setTimeout(r, 20))
  const [a] = c.snapshot()['W@r']!
  assert.equal(a!.text, '許可待ち: コマンド: ls')
  assert.equal(c.snapshot()['W@r']!.length, 1, '知らない形は預からず、同じ要求は 1 つ')
  assert.ok(!fake.sent.some((m) => m.id !== undefined && m.method === undefined), '自分からは答えない（エラーも返さない）')

  // 出していない候補・向きの違う答えは送らない
  assert.equal(c.answer(a!.approval_id, { behavior: 'allow', decision: 'd9' }).ok, false)
  assert.equal(c.answer(a!.approval_id, { behavior: 'deny', decision: 'd0' }).ok, false)
  assert.deepEqual(c.answer(a!.approval_id, { behavior: 'allow', decision: 'd0' }), { ok: true })
  await wait(() => fake.sent.some((m) => m.id === 501 && m.method === undefined))
  assert.deepEqual(fake.sent.filter((m) => m.method === undefined && m.id !== undefined), [{ id: 501, result: { decision: 'accept' } }])
  assert.equal((c.answer(a!.approval_id, { behavior: 'allow', decision: 'd0' }) as { status?: number }).status, 404, '二度は答えない')

  // TUI で先に答えられたら畳む
  fake.push(cmdRequest('r-7', 'W'))
  await wait(() => (c.snapshot()['W@r'] ?? []).length === 1)
  fake.push({ method: 'serverRequest/resolved', params: { threadId: 'W', requestId: 'r-7' } })
  await wait(() => (c.snapshot()['W@r'] ?? []).length === 0)

  // 切れたら預かりも resume も忘れる
  await fake.close()
  await wait(() => c.link() !== 'connected')
  assert.equal(receives(c, 'W'), false)
  assert.deepEqual(c.snapshot(), {})
  c.stop()
})

test('差分の分からないファイル変更の許可は預からない。item/started で差分を受けていれば出す（#848 の 3 のレビュー）', async () => {
  const fake = new FakeDaemon(sockPath())
  await fake.listen()
  const c = daemonClient({ socketPath: fake.path })
  c.setEnabled(true)
  await wait(() => c.link() === 'connected')
  await waitingOn(fake, c, 'W')
  assert.equal(await c.resume('W', 'W@r'), true)
  const fileReq = (id: number, itemId: string) => ({ id, method: 'item/fileChange/requestApproval', params: { threadId: 'W', turnId: 'T1', itemId, reason: 'r' } })
  fake.push(fileReq(801, 'F1'))
  fake.push({ method: 'item/started', params: { threadId: 'W', item: { id: 'F2', type: 'fileChange', changes: [{ path: 'a.txt', diff: '+x' }] } } })
  fake.push(fileReq(802, 'F2'))
  await wait(() => (c.snapshot()['W@r'] ?? []).length === 1)
  await new Promise((r) => setTimeout(r, 20))
  const list = c.snapshot()['W@r']!
  assert.equal(list.length, 1, '差分の無い方は預からない（画面の読み取りに任せる）')
  assert.equal(list[0]!.text, '許可待ち: ファイル変更: a.txt')
  c.stop()
  await fake.close()
})

test('畳んだあと少しの間は settling に出す。resume し直すと新しいエンティティに出す。item はターンの単位で捨てる（#848 の 3 のレビュー）', async () => {
  const fake = new FakeDaemon(sockPath())
  await fake.listen()
  let clock = 1_000_000
  const c = daemonClient({ socketPath: fake.path, now: () => clock })
  c.setEnabled(true)
  await wait(() => c.link() === 'connected')
  await waitingOn(fake, c, 'W')
  assert.equal(await c.resume('W', 'W@r'), true)
  fake.push(cmdRequest(901, 'W'))
  await wait(() => (c.snapshot()['W@r'] ?? []).length === 1)
  assert.deepEqual([...c.settling()], [])
  c.answer(c.snapshot()['W@r']![0]!.approval_id, { behavior: 'deny', decision: 'd1' })
  assert.deepEqual([...c.settling()], ['W'], '答えた直後')
  clock += DAEMON_SETTLE_MS
  assert.deepEqual([...c.settling()], [], '時間が経てば外す')
  fake.push(cmdRequest(902, 'W'))
  await wait(() => (c.snapshot()['W@r'] ?? []).length === 1)
  fake.push({ method: 'serverRequest/resolved', params: { threadId: 'W', requestId: 902 } })
  await wait(() => c.settling().has('W'))

  assert.equal(await c.resume('W', 'W@r2'), true)
  // 前のターンの終わりが遅れて届いても、次のターンの item は消さない
  fake.push({ method: 'item/started', params: { threadId: 'W', turnId: 'T2', item: { id: 'F9', type: 'fileChange', changes: [{ path: 'b.txt' }] } } })
  fake.push({ method: 'turn/completed', params: { threadId: 'W', turn: { id: 'T1' } } })
  fake.push({ id: 903, method: 'item/fileChange/requestApproval', params: { threadId: 'W', turnId: 'T2', itemId: 'F9' } })
  await wait(() => (c.snapshot()['W@r2'] ?? []).length === 1)
  assert.equal(c.snapshot()['W@r2']![0]!.text, '許可待ち: ファイル変更: b.txt')
  assert.equal(c.snapshot()['W@r'], undefined)
  c.stop()
  await fake.close()
})

test('resume 済みのスレッドも待ちのたびに知らせ、確かめ直すまでは出さない。通れば新しいエンティティに出し、通らなければ受けるのをやめる。押せない許可は預からない（#848 の 3 の再レビュー）', async () => {
  const fake = new FakeDaemon(sockPath())
  await fake.listen()
  const c = daemonClient({ socketPath: fake.path })
  const told: string[] = []
  c.onWaiting((id) => {
    told.push(id)
    if (id === 'V') void c.resume('V', 'V@r')
  })
  c.setEnabled(true)
  await wait(() => c.link() === 'connected')
  await waitingOn(fake, c, 'W')
  assert.equal(await c.resume('W', 'W@r'), true)
  const resumes = () => fake.sent.filter((m) => m.method === 'thread/resume').length
  assert.equal(resumes(), 1)

  const waitingNow = (threadId: string) => fake.push({ method: 'thread/status/changed', params: { threadId, status: { type: 'active', activeFlags: ['waitingOnApproval'] } } })
  const idleNow = (threadId: string) => fake.push({ method: 'thread/status/changed', params: { threadId, status: { type: 'idle' } } })
  // 同じ待ちの中で届いた要求では確かめ直さない（1 つの待ちで二度確かめない）
  fake.push(cmdRequest(950, 'W'))
  await wait(() => (c.snapshot()['W@r'] ?? []).length === 1)
  assert.deepEqual(told, ['W'])
  // 次の待ち
  idleNow('W')
  waitingNow('W')
  fake.push(cmdRequest(951, 'W'))
  await wait(() => told.length === 2)
  await new Promise((r) => setTimeout(r, 20))
  assert.deepEqual(told, ['W', 'W'], 'resume 済みでも知らせる')
  assert.ok(c.settling().has('W'), '確かめ直しの間は画面の読み取りも抑える')
  assert.deepEqual(c.snapshot(), {}, '確かめ直すまでは出さない')
  assert.equal(await c.resume('W', 'W@r2'), true)
  assert.equal(resumes(), 1, 'resume 済みなら送り直さない')
  assert.deepEqual(Object.keys(c.snapshot()), ['W@r2'], '預かっていた分も新しいエンティティに出す')

  // 確かめ直しが通らなければ、受けるのをやめる（daemon には何も送らない）
  idleNow('W')
  waitingNow('W')
  await wait(() => told.length === 3)
  const sentBefore = fake.sent.length
  c.release('W')
  assert.deepEqual(c.snapshot(), {})
  assert.equal(receives(c, 'W'), false)
  fake.push(cmdRequest(952, 'W'))
  await new Promise((r) => setTimeout(r, 20))
  assert.deepEqual(c.snapshot(), {}, 'やめたあとの要求は預からない')
  assert.equal(fake.sent.length, sentBefore, '何も送らない')

  // 押せる候補が無い許可は預からない
  await waitingOn(fake, c, 'V')
  await wait(() => receives(c, 'V'))
  fake.push(cmdRequest(953, 'V', { availableDecisions: [{ unknownAmendment: {} }] }))
  fake.push(cmdRequest(954, 'V'))
  await wait(() => (c.snapshot()['V@r'] ?? []).length === 1)
  await new Promise((r) => setTimeout(r, 20))
  assert.equal(c.snapshot()['V@r']!.length, 1)
  c.stop()
  await fake.close()
})

test('確かめ直しの間は押しても消さずに 409。古いターンの許可は断る。投げかけの resume は release で取り消す（#848 の 3 のレビュー）', async () => {
  const fake = new FakeDaemon(sockPath())
  await fake.listen()
  const c = daemonClient({ socketPath: fake.path })
  let confirm: (() => void) | null = null
  c.onWaiting((id) => {
    confirm = () => void c.resume(id, 'W@r')
  })
  c.setEnabled(true)
  await wait(() => c.link() === 'connected')
  await waitingOn(fake, c, 'W')
  assert.equal(await c.resume('W', 'W@r'), true)
  // 待ちを抜けたあと、状態の通知より先に次の要求が届く: 要求で確かめ直しに回す
  fake.push({ method: 'thread/status/changed', params: { threadId: 'W', status: { type: 'active', activeFlags: [] } } })
  await wait(() => c.state('W') === 'active')
  confirm = null
  fake.push(cmdRequest(961, 'W'))
  await wait(() => confirm !== null)
  // 確かめ直しの間は snapshot に出ないので、預かりの中から引く
  const id = [...(c as unknown as { approvals: Map<string, unknown> }).approvals.keys()][0]!
  assert.ok(c.getApproval(id), '確かめ直しの間も答える口は引ける')
  assert.equal((c.answer(id, { behavior: 'allow', decision: 'd0' }) as { status?: number }).status, 409)
  assert.ok(!fake.sent.some((m) => m.id === 961 && m.method === undefined), '送らない')
  confirm!()
  await wait(() => (c.snapshot()['W@r'] ?? []).length === 1)
  // 新しいターンが始まったら、前のターンの許可には答えない
  fake.push({ method: 'turn/started', params: { threadId: 'W', turn: { id: 'T2' } } })
  await new Promise((r) => setTimeout(r, 20))
  assert.equal((c.answer(id, { behavior: 'allow', decision: 'd0' }) as { status?: number }).status, 409)
  assert.ok(!fake.sent.some((m) => m.id === 961 && m.method === undefined), '古いターンには送らない')

  // 投げかけの resume は release で取り消す
  const push = fake.push.bind(fake)
  let held: unknown = null
  fake.push = (m) => {
    const rid = (m as { id?: number }).id
    if (fake.sent.some((x) => x.id === rid && x.method === 'thread/resume')) held = m
    else push(m)
  }
  await waitingOn(fake, c, 'V')
  // 待っていない（確かめの間に答えられた・閉じた）スレッドは新しく resume しない
  fake.push({ method: 'thread/status/changed', params: { threadId: 'Z', status: { type: 'idle' } } })
  await wait(() => c.state('Z') === 'idle')
  assert.equal(await c.resume('Z', 'Z@r'), false)
  assert.equal(await c.resume('Q', 'Q@r'), false)
  assert.ok(!fake.sent.some((m) => m.method === 'thread/resume' && ['Z', 'Q'].includes((m as { params?: { threadId?: string } }).params?.threadId ?? '')))
  const pending = c.resume('V', 'V@r')
  await wait(() => held !== null)
  c.release('V')
  push(held)
  assert.equal(await pending, false)
  assert.equal(receives(c, 'V'), false)
  c.stop()
  await fake.close()
})

test('resume の応答を待つ間にスレッドが閉じたら、受けるスレッドにしない（#848 の 3 のレビュー）', async () => {
  const fake = new FakeDaemon(sockPath())
  await fake.listen()
  const push = fake.push.bind(fake)
  fake.push = (m) => {
    const id = (m as { id?: number }).id
    if (fake.sent.some((x) => x.id === id && x.method === 'thread/resume')) push({ method: 'thread/closed', params: { threadId: 'W' } })
    push(m)
  }
  const c = daemonClient({ socketPath: fake.path })
  c.setEnabled(true)
  await wait(() => c.link() === 'connected')
  await waitingOn(fake, c, 'W')
  assert.equal(await c.resume('W', 'W@r'), false)
  assert.equal(receives(c, 'W'), false)
  c.stop()
  await fake.close()
})

test('resume の応答より先に届いた要求も預かる。resume が通らなければ出さない（#848 の 3）', async () => {
  const fake = new FakeDaemon(sockPath())
  await fake.listen()
  const push = fake.push.bind(fake)
  let failResume = false
  fake.push = (m) => {
    const id = (m as { id?: number }).id
    const sent = fake.sent.find((x) => x.id === id && x.method === 'thread/resume')
    if (sent) {
      // 応答の前に、待っていた許可が届く
      push(cmdRequest(700 + (id ?? 0), (sent as { params?: { threadId?: string } }).params!.threadId!))
      return push(failResume ? { id, error: { message: 'no thread' } } : m)
    }
    push(m)
  }
  const c = daemonClient({ socketPath: fake.path })
  c.setEnabled(true)
  await wait(() => c.link() === 'connected')
  await waitingOn(fake, c, 'W')
  assert.equal(await c.resume('W', 'W@r'), true)
  await wait(() => (c.snapshot()['W@r'] ?? []).length === 1)
  failResume = true
  await waitingOn(fake, c, 'V')
  assert.equal(await c.resume('V', 'V@r'), false)
  await new Promise((r) => setTimeout(r, 20))
  assert.equal(c.snapshot()['V@r'], undefined)
  assert.equal(receives(c, 'V'), false)
  c.stop()
  await fake.close()
})

test('応答の error が文字列にできない形でも、待っている要求は返り、繋ぎ直しに進む（#859 で見送った分）', async () => {
  const fake = new FakeDaemon(sockPath())
  await fake.listen()
  const push = fake.push.bind(fake)
  fake.push = (m) => push((m as { result?: { data?: unknown } }).result?.data ? { id: (m as { id: number }).id, error: { message: { toString: 1 } } } : m)
  const c = daemonClient({ socketPath: fake.path, retryMs: 60_000 })
  c.setEnabled(true)
  await wait(() => c.link() === 'failed')
  c.stop()
  await fake.close()
  assert.equal(errorMessage({ message: 'x' }), 'x')
  assert.equal(errorMessage({ message: { toString: 1 } }), 'error')
  assert.equal(errorMessage(null), 'error')
  assert.equal(errorMessage('boom'), 'boom')
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
