// 端末で開いている相手へのメッセージ（#800）。端末に打ち込めないときだけ別プロセスへ回す。
// 端末の偽物（tmux・ps）とエージェント用の口を一緒に使うので、アプリごと別に立てる。本物のセッションも端末も触らない
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import type { Server } from 'node:http'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { COMPACT_MIN_TOKENS } from '../shared/compact.ts'
import { sendHow, TERMINAL_UNKNOWN_PAUSED } from '../shared/agentMessages.ts'
import { pendingItems, TERMINAL_STUCK_TEXT, todoItems } from '../shared/todoItems.ts'
import type { AgentSendResponse, ReplyFailure, Replying, SessionProgressResponse, SessionSummary, SessionsResponse, UsageResponse } from '../shared/types.ts'
import { createApp } from './app.ts'
import { Approvals } from './approvals/approvals.ts'
import { Authenticator } from './auth.ts'
import { BuildFreshness } from './local/buildFreshness.ts'
import type { ProgressReader, TerminalTail } from './local/progress.ts'
import type { UsageStore } from './local/usage.ts'
import { AGENT_TOKEN_FILE } from './reply/agentMessages.ts'
import type { CodexApp } from './reply/codexAppServer.ts'
import type { ReplyCommand, Runner } from './reply/runner.ts'
import { TerminalReplies } from './reply/terminal.ts'
import type { Tmux } from './reply/terminal.ts'
import { localDate } from './rows/aggregate.ts'
import { row } from './rows/aggregate.test.ts'
import { FeedStore } from './rows/store.ts'

let dir: string
let work: string
let server: Server
let base: string
let token: string

/** 実際には起動しない。busy に入れた id は「処理中」。finish() で終わらせると、預かりの続き（drain）が回る */
class FakeRunner implements Runner {
  started: { id: string; cmd: ReplyCommand }[] = []
  busy = new Map<string, Replying>()
  exits = new Map<string, (failure: ReplyFailure | null) => void | Promise<void>>()
  running(id: string) {
    const r = this.busy.get(id)
    return r !== undefined && !r.failed
  }
  snapshot() {
    return Object.fromEntries(this.busy)
  }
  async start(id: string, cmd: ReplyCommand, onExit?: (failure: ReplyFailure | null) => void | Promise<void>) {
    this.started.push({ id, cmd })
    this.busy.set(id, { since: new Date().toISOString(), text: cmd.text })
    if (onExit) this.exits.set(id, onExit)
  }
  async finish(id: string) {
    this.busy.delete(id)
    const onExit = this.exits.get(id)
    this.exits.delete(id)
    await onExit?.(null)
  }
}
const runner = new FakeRunner()
const codexApp: CodexApp = {
  running: () => false,
  replying: () => ({}),
  snapshot: () => ({}),
  getApproval: () => undefined,
  async start() {},
  answer: () => ({ ok: false, status: 404, error: 'approval not found' }),
}
const usage = { value: {} as UsageResponse, async get() { return this.value } }

/**
 * 相手の transcript の偽物。`closed` = 最後のターンが閉じている、`active` = 回っている。どちらも無ければ分からない。
 * `tail` は SAI の `-p` のあとの中身（`terminalTail()`。既定は「TUI は何も書いておらず、要約だけでもない」）
 */
const turns = new Map<string, { active?: boolean; closed?: boolean; tail?: Partial<TerminalTail> }>()
const contexts = new Map<string, number>()
const progress = {
  async read(s: Pick<SessionSummary, 'id'>): Promise<SessionProgressResponse> {
    const t = turns.get(s.id)
    return {
      rev: '',
      id: s.id,
      active: t?.active === true,
      steps: [],
      total: 0,
      updated_at: t ? new Date().toISOString() : '',
      ...(t?.closed ? { closed_at: new Date().toISOString() } : {}),
      context_tokens: contexts.get(s.id) ?? 0,
    }
  },
  async terminalTail(s: Pick<SessionSummary, 'id'>): Promise<TerminalTail | null> {
    const t = turns.get(s.id)
    // 本物（`ProgressReader.terminalTail()`）は、SAI の -p の始まりまで届かなければ null を返す
    if (!t || t.tail?.reached === false) return null
    return { tui: false, tuiClosed: false, compactOnly: false, reached: true, ...t.tail }
  },
}

const IDLE = '──────\n❯ Try "refactor <filepath>"\n──────\n'
const TYPED = IDLE.replace('❯ Try "refactor <filepath>"', '❯ 人の打ちかけ')
const DIALOG = IDLE + '  ❯ 1. Yes\n    2. No\n  Enter to confirm · Esc to cancel\n'
class FakeTmux implements Tmux {
  calls: string[][] = []
  screen = IDLE
  async run(args: string[]): Promise<string> {
    this.calls.push(args)
    if (args[0] === 'display-message') return '100\n'
    if (args[0] === 'capture-pane') return this.screen
    return ''
  }
}
const tmux = new FakeTmux()
/** 端末に何かを打った・消したか（打ちかけを消さない・本文を二重に届けない） */
const typedKeys = () => tmux.calls.filter((c) => c[0] === 'paste-buffer' || c[0] === 'load-buffer' || (c[0] === 'send-keys' && c.length > 3))

before(async () => {
  process.env.AGENT_FEED_HOST = 'testmac'
  dir = await mkdtemp(join(tmpdir(), 'sai-agent-term-'))
  work = await mkdtemp(join(tmpdir(), 'sai-agent-term-work-'))
  const now = new Date()
  await writeFile(
    join(dir, `${localDate(now.toISOString())}.jsonl`),
    [
      row(new Date(now.getTime() - 9 * 60_000), 'A1', { repo: 'r', cwd: work, project: 'o/r', user_text: '実装して' }),
      // 端末で開いている Claude（pid 200 はペインの中で生きている）
      row(new Date(now.getTime() - 8 * 60_000), 'T1', { repo: 'r', cwd: work, project: 'o/r', pane: '%9', pid: 200, user_text: '前の作業', text: '済みました' }),
    ]
      .map((r) => JSON.stringify(r))
      .join('\n') + '\n',
  )
  const app = createApp(
    new FeedStore(dir),
    join(dir, 'dist'),
    runner,
    new Approvals(),
    new BuildFreshness(join(dir, 'dist'), [], 0),
    undefined,
    new Authenticator(async () => null),
    {
      tmux,
      ps: async () => ' 100     1\n 200   100\n',
      replies: new TerminalReplies(),
      alive: (pid) => pid === 200,
      scanTtlMs: 0,
      // 端末でターンの途中で待っている預かりを、ポーリングのたびに見に行かせる
      bgRetryMs: 0,
      codexApp,
    },
    undefined,
    undefined,
    undefined,
    usage as unknown as UsageStore,
    progress as unknown as ProgressReader,
  )
  token = (await readFile(join(dir, AGENT_TOKEN_FILE), 'utf-8')).trim()
  server = createServer((req, res) => void app(req, res))
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const addr = server.address()
  base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`
})

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
  await rm(dir, { recursive: true, force: true })
  await rm(work, { recursive: true, force: true })
})

const send = (body: object) =>
  fetch(`${base}/api/agent/send`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-SAI-Agent-Token': token },
    body: JSON.stringify({ from: 'A1@r', to: 'T1@r', ...body }),
  })
const sessions = async () => (await (await fetch(`${base}/api/sessions?days=30`)).json()) as SessionsResponse
/** 送り元 A1 が SAI から起動したターンを回している（毎回別のターンにして、1 ターンの回数に当たらないようにする） */
const senderTurn = () => runner.busy.set('A1@r', { since: `${Date.now()}-${Math.random()}`, text: 'やって' })
const reset = async () => {
  runner.busy.delete('T1@r')
  runner.exits.clear()
  // 一覧を引くと残った預かりが回るので、端末をダイアログ中・ターンの途中にしてから消す
  tmux.screen = DIALOG
  turns.set('T1@r', { active: true })
  for (const item of (await sessions()).queued['T1@r']?.items ?? []) {
    await fetch(`${base}/api/sessions/T1%40r/queue/${item.queue_id}`, { method: 'DELETE', headers: { Origin: base } })
  }
  // 止めた印も外す（空の預かりで「続けて送る」）
  await fetch(`${base}/api/sessions/T1%40r/queue/resume`, { method: 'POST', headers: { Origin: base } })
  runner.started.length = 0
  tmux.calls.length = 0
  tmux.screen = IDLE
  turns.clear()
  contexts.clear()
  senderTurn()
}

test('sai_send: 端末に打ちかけがあり、端末のターンの外なら、打ちかけを消さずに別プロセスで 1 回だけ起こす（#800）', async () => {
  await reset()
  tmux.screen = TYPED
  turns.set('T1@r', { closed: true })
  const res = await send({ text: '見てください' })
  assert.equal(res.status, 202, JSON.stringify(await res.clone().json()))
  const body = (await res.json()) as AgentSendResponse
  assert.equal(body.via, 'process')
  assert.equal(body.past_terminal, true)
  assert.equal(runner.started.length, 1, '本文は 1 回だけ届く')
  const args = runner.started[0]!.cmd.args
  assert.deepEqual(args.slice(args.indexOf('-p'), args.indexOf('-p') + 3), ['-p', '--resume', 'T1'])
  assert.match(runner.started[0]!.cmd.text, /見てください/)
  assert.deepEqual(typedKeys(), [], '端末には何も打たず、打ちかけも消さない')
  assert.equal(tmux.screen, TYPED)
  assert.match(sendHow(body.via!, body.past_terminal), /打ち込めなかったので、別プロセス/)
  const log = await readFile(join(dir, 'reply.log'), 'utf-8')
  assert.match(log, /メッセージを端末に打ち込めなかったので、別プロセスで回す/)
})

test('sai_send: 端末でターンの途中・ダイアログ中なら、別プロセスを起こさずに預かる。止めずに待ち、ターンが終われば回る（#800）', async () => {
  for (const [name, screen, turn] of [
    ['ターンの途中', TYPED, { active: true }],
    ['ダイアログ中', DIALOG, { closed: true }],
  ] as const) {
    await reset()
    tmux.screen = screen
    turns.set('T1@r', turn)
    const res = await send({ text: `${name}の相手へ` })
    assert.equal(res.status, 202, `${name}: ${JSON.stringify(await res.clone().json())}`)
    const body = (await res.json()) as AgentSendResponse
    assert.equal(body.via, 'queued', name)
    assert.equal(body.past_terminal, true, name)
    assert.equal(body.stuck, undefined, name)
    assert.match(sendHow(body.via!, body.past_terminal, body.stuck), /端末でターンの途中なので、終わってから回ります/)
    assert.equal(runner.started.length, 0, `${name}: 同じセッションを 2 つのプロセスで回さない`)
    assert.deepEqual(typedKeys(), [], name)
    // ポーリングが来ても、まだ起こさない（預かりも止めない）
    const during = (await sessions()).queued['T1@r']
    assert.deepEqual(during?.items.map((i) => i.text.includes(`${name}の相手へ`)), [true], name)
    assert.equal(during?.paused ?? '', '', name)
    assert.equal(runner.started.length, 0, name)
  }
  // ダイアログが閉じて打ちかけだけ残っていれば、次のポーリングで別プロセスで回る
  tmux.screen = TYPED
  turns.set('T1@r', { closed: true })
  await sessions()
  assert.equal(runner.started.length, 1)
  assert.match(runner.started[0]!.cmd.text, /ダイアログ中の相手へ/)
  assert.deepEqual(typedKeys(), [])
  assert.equal((await sessions()).queued['T1@r'], undefined)
})

test('sai_send: 端末のターンが閉じたか分からないなら、預かったまま止めて送り元と要対応に出す。人が「続けて送る」で別プロセスで 1 回だけ回す（#800）', async () => {
  for (const [name, turn] of [
    ['transcript が読めない', undefined],
    ['閉じたか分からない', { active: false }],
  ] as const) {
    await reset()
    tmux.screen = TYPED
    if (turn) turns.set('T1@r', turn)
    const res = await send({ text: `${name}の相手へ` })
    assert.equal(res.status, 202, `${name}: ${JSON.stringify(await res.clone().json())}`)
    const body = (await res.json()) as AgentSendResponse
    assert.equal(body.via, 'queued', name)
    assert.equal(body.stuck, true, name)
    assert.match(sendHow(body.via!, body.past_terminal, body.stuck), /預かったまま止まっています/, name)
    const data = await sessions()
    assert.equal(data.queued['T1@r']?.paused, TERMINAL_UNKNOWN_PAUSED, name)
    const todo = todoItems(data.sessions, data.approvals, data.host, data.replying, data.loops, data.waits, data.queued).filter((t) => t.id === 'T1@r')
    assert.deepEqual(todo.map((t) => [t.kind, t.text]), [['watch', TERMINAL_STUCK_TEXT]], `${name}: 要対応に 1 行だけ出す（数える）`)
    assert.equal(pendingItems(todo).length, 1)
    assert.equal(runner.started.length, 0, name)
    assert.deepEqual(typedKeys(), [], name)
  }
  // 端末でターンが回っている間は、「続けて送る」を押しても起こさない（押した分は持ち越さない）
  turns.set('T1@r', { active: true })
  const resume = () => fetch(`${base}/api/sessions/T1%40r/queue/resume`, { method: 'POST', headers: { Origin: base } })
  assert.equal((await resume()).status, 200)
  assert.equal(runner.started.length, 0)
  // 回っていなくなったが、閉じたかはまだ分からない（止めた預かりはもう一度止まる。押した分は使われていない）
  turns.set('T1@r', { active: false })
  await sessions()
  assert.equal(runner.started.length, 0)
  assert.equal((await sessions()).queued['T1@r']?.paused, TERMINAL_UNKNOWN_PAUSED)
  // 人が押せば、分からなくても別プロセスで 1 回だけ回す。端末には何も打たない
  assert.equal((await resume()).status, 200)
  assert.equal(runner.started.length, 1)
  assert.match(runner.started[0]!.cmd.text, /閉じたか分からないの相手へ/)
  assert.deepEqual(typedKeys(), [])
  assert.equal((await sessions()).queued['T1@r'], undefined)
})

test('sai_send: 要約を挟む依頼は、端末で開いていても空いていれば別プロセスで要約してから、本文も別プロセスで回す（#800）', async () => {
  await reset()
  turns.set('T1@r', { closed: true })
  contexts.set('T1@r', COMPACT_MIN_TOKENS)
  const res = await send({ text: '続きを見てください', compact: true })
  assert.equal(res.status, 202, JSON.stringify(await res.clone().json()))
  const body = (await res.json()) as AgentSendResponse
  assert.equal(body.via, 'compact')
  assert.equal(body.past_terminal, true)
  assert.match(sendHow(body.via!, body.past_terminal), /端末で開いていますが、別プロセス/)
  assert.equal(runner.started.length, 1)
  assert.match(runner.started[0]!.cmd.text, /^\/compact /)
  assert.deepEqual(typedKeys(), [], '端末が空いていても打ち込まない（開いている TUI は要約を知らない）')

  // 要約が終わったら、本文は端末に打たずに別プロセスで回す。`/compact` だけのターンは transcript に閉じた印を書かず、
  // しばらく「回っている」に見えるが、最後が SAI の要約の出力で TUI が何も書いていなければ、端末の側では何も始まっていない
  turns.set('T1@r', { active: true, tail: { compactOnly: true } })
  await runner.finish('T1@r')
  assert.equal(runner.started.length, 2)
  assert.match(runner.started[1]!.cmd.text, /続きを見てください/)
  assert.deepEqual(typedKeys(), [])
  await runner.finish('T1@r')
})

test('sai_send: 要約の間に端末でターンが始まっていたら、要約の出力が最後でも本文は起こさずに待ち、TUI のターンが閉じたら回す（#800 のレビュー）', async () => {
  for (const [name, during] of [
    // TUI がターンを始めた行を書いたあと、要約の行が最後に来た（TUI は LLM を待っていて何も書いていない）
    ['要約の出力が最後', { active: false, tail: { tui: true, compactOnly: true } }],
    ['TUI が書いている', { active: true, tail: { tui: true } }],
  ] as const) {
    await reset()
    turns.set('T1@r', { closed: true })
    contexts.set('T1@r', COMPACT_MIN_TOKENS)
    assert.equal(((await (await send({ text: '続きを見てください', compact: true })).json()) as AgentSendResponse).via, 'compact', name)
    turns.set('T1@r', during)
    await runner.finish('T1@r')
    await sessions()
    assert.equal(runner.started.length, 1, `${name}: 本文は起こさない`)
    const held = (await sessions()).queued['T1@r']
    assert.equal(held?.items.length, 1, name)
    assert.equal(held?.paused ?? '', '', `${name}: 止めずに待つ`)
    // TUI のターンが閉じた
    turns.set('T1@r', { closed: true, tail: { tui: true, tuiClosed: true } })
    await sessions()
    assert.equal(runner.started.length, 2, name)
    assert.match(runner.started[1]!.cmd.text, /続きを見てください/)
    assert.deepEqual(typedKeys(), [], name)
    await runner.finish('T1@r')
  }
})

test('sai_send: SAI の -p のあとに TUI が書いたかが読めない（transcript が届かない）なら、閉じた印があっても起こさない（#800 のレビュー）', async () => {
  await reset()
  tmux.screen = TYPED
  turns.set('T1@r', { closed: true })
  // 1 通目は別プロセスで回り、SAI の -p の時刻が残る
  assert.equal(((await (await send({ text: '1 通目' })).json()) as AgentSendResponse).via, 'process')
  await runner.finish('T1@r')
  turns.set('T1@r', { closed: true, tail: { reached: false } })
  senderTurn()
  const body = (await (await send({ text: '2 通目' })).json()) as AgentSendResponse
  assert.equal(body.via, 'queued')
  assert.equal(body.stuck, true)
  assert.equal(runner.started.length, 1)
})

test('sai_send: 画面にダイアログが出ていれば、transcript のターンが閉じていても要約の別プロセスは起こさずに待つ（#800 のレビュー）', async () => {
  await reset()
  tmux.screen = DIALOG
  turns.set('T1@r', { closed: true })
  contexts.set('T1@r', COMPACT_MIN_TOKENS)
  const res = await send({ text: '続きを見てください', compact: true })
  assert.equal(res.status, 202, JSON.stringify(await res.clone().json()))
  const body = (await res.json()) as AgentSendResponse
  assert.equal(body.via, 'queued')
  assert.equal(body.stuck, undefined, '止めずに待つ')
  assert.equal(runner.started.length, 0)
  assert.deepEqual(typedKeys(), [])
})

test('sai_send: 止めた預かりの後ろに並んだメッセージにも「預かったまま止まっています」を返す（#800 のレビュー）', async () => {
  await reset()
  tmux.screen = TYPED
  turns.set('T1@r', { active: false })
  assert.equal(((await (await send({ text: '1 通目' })).json()) as AgentSendResponse).stuck, true)
  senderTurn()
  const second = (await (await send({ text: '2 通目' })).json()) as AgentSendResponse
  assert.equal(second.via, 'queued')
  assert.equal(second.stuck, true)
  assert.equal(runner.started.length, 0)
})

test('人の画面からの返信は今までどおり: 打ちかけがあれば 409 と can_process で、別プロセスへは回さない（#800）', async () => {
  await reset()
  tmux.screen = TYPED
  turns.set('T1@r', { closed: true })
  const res = await fetch(`${base}/api/sessions/T1%40r/reply?days=30`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: base },
    body: JSON.stringify({ text: '人から' }),
  })
  assert.equal(res.status, 409)
  assert.equal(((await res.json()) as { can_process?: boolean }).can_process, true)
  assert.equal(runner.started.length, 0)
})

test('sai_send: 端末が空いていれば今までどおり端末に打ち込む（既定は端末。#800）', async () => {
  // 端末に打つと、そのターンの行が届くまで「打ち込んだ返信を待っている」になるので最後に置く
  await reset()
  turns.set('T1@r', { closed: true })
  const res = await send({ text: '見てください' })
  assert.equal(res.status, 202, JSON.stringify(await res.clone().json()))
  const body = (await res.json()) as AgentSendResponse
  assert.equal(body.via, 'terminal')
  assert.equal(body.past_terminal, undefined)
  assert.equal(runner.started.length, 0, '別プロセスは起こさない')
  assert.equal(tmux.calls.filter((c) => c[0] === 'paste-buffer').length, 1)
})
