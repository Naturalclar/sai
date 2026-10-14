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
import { sendHow, TERMINAL_HELD_PAUSED } from '../shared/agentMessages.ts'
import { pendingItems, TERMINAL_STUCK_TEXT, todoItems } from '../shared/todoItems.ts'
import type { AgentSendResponse, ReplyFailure, Replying, SessionProgressResponse, SessionSummary, SessionsResponse, UsageResponse } from '../shared/types.ts'
import { createApp } from './app.ts'
import { Approvals } from './approvals/approvals.ts'
import { Authenticator } from './auth.ts'
import { BuildFreshness } from './local/buildFreshness.ts'
import type { ProgressReader } from './local/progress.ts'
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

/** 相手の transcript の偽物。`closed` = 最後のターンが閉じている、`active` = 回っている。どちらも無ければ分からない */
const turns = new Map<string, { active?: boolean; closed?: boolean }>()
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
}

const IDLE = '──────\n❯ Try "refactor <filepath>"\n──────\n'
const TYPED = IDLE.replace('❯ Try "refactor <filepath>"', '❯ 人の打ちかけ')
const DIALOG = IDLE + '  ❯ 1. Yes\n    2. No\n  Enter to confirm · Esc to cancel\n'
class FakeTmux implements Tmux {
  calls: string[][] = []
  screen = IDLE
  /** 画面を読むのをこれが解けるまで待たせる（端末を読んでいる間に次のメッセージが来る形を作る） */
  gate: Promise<void> | null = null
  async run(args: string[]): Promise<string> {
    this.calls.push(args)
    if (args[0] === 'display-message') return '100\n'
    if (args[0] === 'capture-pane') {
      if (this.gate) await this.gate
      return this.screen
    }
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

const resume = () => fetch(`${base}/api/sessions/T1%40r/queue/resume`, { method: 'POST', headers: { Origin: base } })
const stuckRows = (data: SessionsResponse) =>
  todoItems(data.sessions, data.approvals, data.host, data.replying, data.loops, data.waits, data.queued).filter((t) => t.id === 'T1@r')

test('sai_send: 端末に打ち込めない（打ちかけ・ダイアログ・読めない）なら、別プロセスへは自動で回さず、預かって止め、送り元と要対応に出す（#800）', async () => {
  for (const [name, screen, turn] of [
    ['打ちかけ・ターンの外', TYPED, { closed: true }],
    ['打ちかけ・ターンの途中', TYPED, { active: true }],
    ['ダイアログ中', DIALOG, { closed: true }],
    ['画面が読めない', '$ ls\n$ ', undefined],
  ] as const) {
    await reset()
    tmux.screen = screen
    if (turn) turns.set('T1@r', turn)
    const res = await send({ text: `${name}の相手へ` })
    assert.equal(res.status, 202, `${name}: ${JSON.stringify(await res.clone().json())}`)
    const body = (await res.json()) as AgentSendResponse
    assert.equal(body.via, 'queued', name)
    assert.equal(body.past_terminal, true, name)
    assert.equal(body.stuck, true, name)
    assert.match(sendHow(body.via!, body.stuck), /預かったまま止まっています/, name)
    assert.equal(runner.started.length, 0, `${name}: 別プロセスを起こさない`)
    assert.deepEqual(typedKeys(), [], `${name}: 端末には何も打たず、打ちかけも消さない`)
    assert.equal(tmux.screen, screen, name)
    const data = await sessions()
    assert.equal(data.queued['T1@r']?.paused, TERMINAL_HELD_PAUSED, name)
    assert.deepEqual(stuckRows(data).map((t) => [t.kind, t.text]), [['watch', TERMINAL_STUCK_TEXT]], `${name}: 要対応に 1 行だけ出す（数える）`)
    assert.equal(pendingItems(stuckRows(data)).length, 1, name)
    // ポーリングが来ても回らない
    await sessions()
    assert.equal(runner.started.length, 0, name)
  }
  const log = await readFile(join(dir, 'reply.log'), 'utf-8')
  assert.match(log, /メッセージを端末に打ち込めない（.*）ので、別プロセスを起こさずに預かった/)
})

test('sai_send: 止めた預かりの後ろに並んだメッセージにも「預かったまま止まっています」を返す（#800）', async () => {
  await reset()
  tmux.screen = TYPED
  turns.set('T1@r', { closed: true })
  assert.equal(((await (await send({ text: '1 通目' })).json()) as AgentSendResponse).stuck, true)
  senderTurn()
  const second = (await (await send({ text: '2 通目' })).json()) as AgentSendResponse
  assert.equal(second.via, 'queued')
  assert.equal(second.stuck, true)
  assert.equal(runner.started.length, 0)
})

test('sai_send: 端末を読んでいる間に同じ相手へ次の返信が来ても、打ち込めずに預かった先の 1 通を追い越させない（#804 のレビュー）', async () => {
  await reset()
  tmux.screen = TYPED
  turns.set('T1@r', { closed: true })
  let open = (): void => {}
  tmux.gate = new Promise<void>((resolve) => (open = resolve))
  try {
    const first = send({ text: '先の 1 通' })
    while (!tmux.calls.some((c) => c[0] === 'capture-pane')) await new Promise((r) => setTimeout(r, 5))
    // 同じ送り元からの送信は 1 つずつ通すので、あとの 1 通は人の画面から預ける（起動中なので預かりに並ぶ）
    const second = await fetch(`${base}/api/sessions/T1%40r/reply?days=30`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: base },
      body: JSON.stringify({ text: 'あとの 1 通', queue: true }),
    })
    assert.equal(((await second.json()) as { via?: string }).via, 'queued')
    open()
    assert.equal(((await (await first).json()) as AgentSendResponse).stuck, true)
  } finally {
    open()
    tmux.gate = null
  }
  const items = (await sessions()).queued['T1@r']?.items ?? []
  assert.deepEqual(items.map((i) => (i.text.includes('先の 1 通') ? '先' : i.text.includes('あとの 1 通') ? 'あと' : '?')), ['先', 'あと'])
  assert.equal(runner.started.length, 0)
})

test('sai_send: 人が「続けて送る」を押すと、打ち込めなければ別プロセスで 1 回だけ回す。そのあとのメッセージは、また止まる（#800）', async () => {
  await reset()
  tmux.screen = TYPED
  turns.set('T1@r', { closed: true })
  assert.equal(((await (await send({ text: '1 通目' })).json()) as AgentSendResponse).stuck, true)
  assert.equal((await resume()).status, 200)
  assert.equal(runner.started.length, 1, '押した 1 回だけ別プロセスで回す')
  const args = runner.started[0]!.cmd.args
  assert.deepEqual(args.slice(args.indexOf('-p'), args.indexOf('-p') + 3), ['-p', '--resume', 'T1'])
  assert.match(runner.started[0]!.cmd.text, /1 通目/)
  assert.deepEqual(typedKeys(), [], '端末には何も打たず、打ちかけも消さない')
  assert.equal((await sessions()).queued['T1@r'], undefined)
  await runner.finish('T1@r')

  // 押した分は使い切った。-p のあと端末が空いて見えても、次のメッセージは自動では別プロセスへ回さない
  senderTurn()
  const next = (await (await send({ text: '2 通目' })).json()) as AgentSendResponse
  assert.equal(next.via, 'queued')
  assert.equal(next.stuck, true)
  await sessions()
  assert.equal(runner.started.length, 1, '2 通目は起こさない')
  assert.equal((await sessions()).queued['T1@r']?.paused, TERMINAL_HELD_PAUSED)
})

test('sai_send: 「続けて送る」を押しても、端末でターンが回っている・ダイアログ中なら起こさない。押した分は持ち越さない（#800）', async () => {
  for (const [name, screen, turn] of [
    ['ターンの途中', TYPED, { active: true }],
    ['ダイアログ中', DIALOG, { closed: true }],
  ] as const) {
    await reset()
    tmux.screen = screen
    turns.set('T1@r', turn)
    assert.equal(((await (await send({ text: `${name}の相手へ` })).json()) as AgentSendResponse).stuck, true, name)
    assert.equal((await resume()).status, 200, name)
    assert.equal(runner.started.length, 0, `${name}: 押しても起こさない`)
    // 端末が空いたように見えても、押した分は残っていないので、次に見たときはまた止まる（自動では回さない）
    tmux.screen = TYPED
    turns.set('T1@r', { closed: true })
    await sessions()
    assert.equal(runner.started.length, 0, name)
    assert.equal((await sessions()).queued['T1@r']?.paused, TERMINAL_HELD_PAUSED, name)
    // もう一度押せば回る
    assert.equal((await resume()).status, 200, name)
    assert.equal(runner.started.length, 1, name)
    assert.deepEqual(typedKeys(), [], name)
    await runner.finish('T1@r')
  }
})

test('sai_send: 「続けて送る」を押したときに打ちかけが片付いていれば、別プロセスではなく端末に打ち込む（#800）', async () => {
  await reset()
  tmux.screen = TYPED
  turns.set('T1@r', { closed: true })
  assert.equal(((await (await send({ text: '片付いたら' })).json()) as AgentSendResponse).stuck, true)
  tmux.screen = IDLE
  assert.equal((await resume()).status, 200)
  assert.equal(runner.started.length, 0, '別プロセスは起こさない')
  assert.equal(tmux.calls.filter((c) => c[0] === 'paste-buffer').length, 1, '端末に 1 回だけ打ち込む')
  assert.equal((await sessions()).queued['T1@r'], undefined)
})

test('sai_send: 端末で開いている相手には、要約を挟む依頼でも別プロセスで要約しない（#806 に分けた）', async () => {
  await reset()
  tmux.screen = TYPED
  turns.set('T1@r', { closed: true })
  contexts.set('T1@r', COMPACT_MIN_TOKENS)
  const body = (await (await send({ text: '続きを見てください', compact: true })).json()) as AgentSendResponse
  assert.equal(body.via, 'queued')
  assert.equal(body.stuck, true)
  assert.equal(runner.started.length, 0)
  assert.deepEqual(typedKeys(), [])
})

test('人の画面からの返信は今までどおり: 打ちかけがあれば 409 と can_process で、預からず別プロセスへも回さない（#800）', async () => {
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
  assert.equal((await sessions()).queued['T1@r'], undefined)
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
  assert.equal(sendHow(body.via!), '相手の端末に打ち込みました')
  assert.equal(runner.started.length, 0, '別プロセスは起こさない')
  assert.equal(tmux.calls.filter((c) => c[0] === 'paste-buffer').length, 1)
})
