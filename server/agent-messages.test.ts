// セッション同士のメッセージ（#310 / #311）。本物の createApp にエージェント用の口を叩かせる。
// 一覧の fixture（app.test.ts）に行を足すと他のテストの件数が変わるので、アプリごと別に立てる
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import type { Server } from 'node:http'
import { appendFile, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AGENT_SEND_MAX } from '../shared/agentMessages.ts'
import type {
  AgentSendResponse,
  AgentSessionsResponse,
  AgentStopResponse,
  AgentWaitResponse,
  Replying,
  SessionDetailResponse,
  SessionProgressResponse,
  SessionsResponse,
  SessionSummary,
  UsageResponse,
} from '../shared/types.ts'
import { createApp } from './app.ts'
import { Approvals } from './approvals/approvals.ts'
import { Authenticator } from './auth.ts'
import { BuildFreshness } from './local/buildFreshness.ts'
import type { ProgressReader } from './local/progress.ts'
import type { UsageStore } from './local/usage.ts'
import { AGENT_TOKEN_FILE } from './reply/agentMessages.ts'
import type { CodexApp } from './reply/codexAppServer.ts'
import type { ReplyCommand, Runner } from './reply/runner.ts'
import { localDate } from './rows/aggregate.ts'
import { row } from './rows/aggregate.test.ts'
import { FeedStore } from './rows/store.ts'

let dir: string
let work: string
let server: Server
let base: string
let feedFile: string
let token: string

/** 実際には起動しない。busy に入れた id は「処理中」（failed 付きは本物と同じく処理中ではない） */
class FakeRunner implements Runner {
  started: { id: string; cmd: ReplyCommand }[] = []
  busy = new Map<string, Replying>()
  running(id: string) {
    const r = this.busy.get(id)
    return r !== undefined && !r.failed
  }
  snapshot() {
    return Object.fromEntries(this.busy)
  }
  async start(id: string, cmd: ReplyCommand) {
    this.started.push({ id, cmd })
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
/** 使用量の偽物（この Mac の ~/.claude / ~/.codex を読まない）。既定は「取れない」 */
const usage = { value: {} as UsageResponse, async get() { return this.value } }
/** 処理中の手順の偽物。相手が読み直す量だけを返す（既定は分からない = 0） */
const contexts = new Map<string, number>()
const progress = {
  async read(s: Pick<SessionSummary, 'id'>): Promise<SessionProgressResponse> {
    return { rev: '', id: s.id, active: false, steps: [], total: 0, updated_at: '', context_tokens: contexts.get(s.id) ?? 0 }
  },
}
const now = new Date()
const minutesAgo = (n: number) => new Date(now.getTime() - n * 60_000)

before(async () => {
  // このサーバのマシン名（#114）。R1 だけ別のマシンにする
  process.env.AGENT_FEED_HOST = 'testmac'
  dir = await mkdtemp(join(tmpdir(), 'sai-agent-'))
  work = await mkdtemp(join(tmpdir(), 'sai-agent-work-'))
  feedFile = join(dir, `${localDate(now.toISOString())}.jsonl`)
  await writeFile(
    feedFile,
    [
      row(minutesAgo(9), 'A1', { repo: 'r', cwd: work, project: 'o/r', user_text: '実装して' }),
      row(minutesAgo(8), 'B1', { repo: 'r', cwd: work, project: 'o/r', user_text: 'レビューして', text: 'レビューしました' }),
      row(minutesAgo(7), 'C1', { repo: 'r', cwd: work, project: 'o/other' }),
      row(minutesAgo(6), 'R1', { repo: 'r', cwd: work, project: 'o/r', host: 'mini' }),
      row(minutesAgo(5), 'S1', { repo: 'r', cwd: work, project: 'o/r', session_source: 'synth' }),
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
    { tmux: { run: async () => { throw new Error('unused') } }, ps: async () => '', codexApp },
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

/** エージェント用の口を叩く。token: null でヘッダを付けない */
const agent = (path: string, init: { method?: string; body?: string; headers?: Record<string, string>; token?: string | null } = {}) => {
  const headers: Record<string, string> = { 'Content-Type': 'application/json', ...(init.headers ?? {}) }
  if (init.token !== null) headers['X-SAI-Agent-Token'] = init.token ?? token
  return fetch(base + path, { method: init.method ?? 'GET', headers, ...(init.body ? { body: init.body } : {}) })
}
const send = (from: string, to: string, text: string) => agent('/api/agent/send', { method: 'POST', body: JSON.stringify({ from, to, text }) })
/** そのセッションが、SAI から起動したターンを回している（since が変わると別のターン） */
const turn = (id: string, since = `${Date.now()}-${Math.random()}`, over: Partial<Replying> = {}) => runner.busy.set(id, { since, text: 'やって', ...over })
const idle = (id: string) => runner.busy.delete(id)
/** 人が画面から返信して、そのセッションのターンを起動し直す（連鎖の印が消える） */
const humanReply = async (id: string) => {
  idle(id)
  const res = await fetch(`${base}/api/sessions/${encodeURIComponent(id)}/reply`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: '人から' }) })
  assert.equal(res.status, 202)
}

test('エージェント用の口: トークンが無い・違う・ブラウザから（Origin 付き）は 403。トークンは 0600 のファイル（#310）', async () => {
  turn('A1@r')
  try {
    const path = '/api/agent/sessions?from=A1%40r'
    assert.equal((await agent(path, { token: null })).status, 403)
    assert.equal((await agent(path, { token: 'f'.repeat(64) })).status, 403)
    assert.equal((await agent(path, { headers: { Origin: base } })).status, 403, '同一オリジンの画面からでも、ブラウザからは通さない')
    assert.equal((await agent(path, { headers: { 'Sec-Fetch-Site': 'same-origin' } })).status, 403)
    assert.equal((await agent(path)).status, 200)
    assert.equal((await stat(join(dir, AGENT_TOKEN_FILE))).mode & 0o777, 0o600)
    assert.equal((await agent('/api/agent/send')).status, 405, 'send は POST だけ')
    assert.equal((await agent('/api/agent/nope')).status, 404)
  } finally {
    idle('A1@r')
  }
})

test('送り元は、SAI から起動していまターンを回しているセッションだけ（止まっている・失敗して残っているだけは 409）', async () => {
  assert.equal((await agent('/api/agent/sessions?from=A1%40r')).status, 409)
  turn('A1@r', 's1', { failed: { code: 1, tail: '' } })
  try {
    assert.equal((await agent('/api/agent/sessions?from=A1%40r')).status, 409)
    assert.equal((await send('A1@r', 'B1@r', '見て')).status, 409)
  } finally {
    idle('A1@r')
  }
})

test('sai_sessions: 同じ project の、返信できる別のセッションだけ。本文は載せない', async () => {
  turn('A1@r')
  turn('B1@r')
  try {
    const res = await agent('/api/agent/sessions?from=A1%40r')
    assert.equal(res.status, 200)
    const body = (await res.json()) as AgentSessionsResponse
    assert.equal(body.from, 'A1@r')
    assert.deepEqual(
      body.sessions.map((s) => s.id),
      ['B1@r'],
      '自分・別の project（C1）・別のマシン（R1）・合成 ID（S1）は出さない',
    )
    assert.deepEqual(body.sessions[0], { id: 'B1@r', name: 'レビューして', project: 'o/r', branch: body.sessions[0]!.branch, agent: 'claude', busy: true, last_text: 'レビューしました', context_tokens: 0 })
    contexts.set('B1@r', 120_000)
    const sized = (await (await agent('/api/agent/sessions?from=A1%40r')).json()) as AgentSessionsResponse
    assert.equal(sized.sessions[0]!.context_tokens, 120_000, '相手が読み直す量（直近の呼び出しの入力。#311）')
    contexts.delete('B1@r')
  } finally {
    idle('A1@r')
    idle('B1@r')
  }
})

test('sai_send: 相手のターンを見出し付きで起動する。送れない相手・空・長すぎる本文は断る', async () => {
  runner.started.length = 0
  turn('A1@r')
  try {
    const res = await send('A1@r', 'B1@r', '  テストを見て  ')
    assert.equal(res.status, 202)
    const body = (await res.json()) as AgentSendResponse
    assert.equal(body.to, 'B1@r')
    assert.equal(body.via, 'process')
    assert.deepEqual([body.sent, body.limit], [1, AGENT_SEND_MAX])
    const { id, cmd } = runner.started.at(-1)!
    assert.equal(id, 'B1@r')
    assert.match(cmd.text, new RegExp(`^【SAI】#o/r の「実装して」からのメッセージです（id: ${body.message_id}）`))
    assert.ok(cmd.text.endsWith('\n\nテストを見て'))

    assert.equal((await send('A1@r', 'C1@r', 'x')).status, 403, '別の project')
    assert.equal((await send('A1@r', 'A1@r', 'x')).status, 403, '自分')
    assert.equal((await send('A1@r', 'R1@r', 'x')).status, 403, '別のマシン')
    assert.equal((await send('A1@r', 'nope@r', 'x')).status, 403)
    assert.equal((await send('A1@r', 'B1@r', '   ')).status, 400)
    assert.equal((await send('A1@r', 'B1@r', 'あ'.repeat(5000))).status, 400)
    assert.equal(runner.started.length, 1, '断ったものは起動しない')
  } finally {
    idle('A1@r')
  }
})

test('連鎖は 1 段まで: メッセージで起動したターンからは送れない。人の返信で起動し直したら送れる（#311）', async () => {
  turn('A1@r')
  assert.equal((await send('A1@r', 'B1@r', '見て')).status, 202)
  idle('A1@r')
  // B1 はいまメッセージで起動したターンを回している
  turn('B1@r')
  try {
    const res = await send('B1@r', 'A1@r', 'さらに頼む')
    assert.equal(res.status, 429)
    assert.match(((await res.json()) as { error: string }).error, /連鎖は 1 段まで/)
  } finally {
    idle('B1@r')
  }
  await humanReply('B1@r')
  turn('B1@r')
  try {
    assert.equal((await send('B1@r', 'A1@r', '人に言われて頼む')).status, 202)
  } finally {
    idle('B1@r')
  }
  await humanReply('A1@r')
  idle('A1@r')
})

test(`1 ターンに ${AGENT_SEND_MAX} 回まで。次のターンでは数え直す（#311）`, async () => {
  turn('A1@r', 'turn-a')
  try {
    for (let i = 0; i < AGENT_SEND_MAX; i++) assert.equal((await send('A1@r', 'B1@r', `${i}`)).status, 202, `${i + 1} 回目`)
    const res = await send('A1@r', 'B1@r', 'もう一回')
    assert.equal(res.status, 429)
    assert.match(((await res.json()) as { error: string }).error, new RegExp(`${AGENT_SEND_MAX} 回まで`))
    turn('A1@r', 'turn-b')
    assert.equal((await send('A1@r', 'B1@r', '次のターン')).status, 202)
  } finally {
    idle('A1@r')
  }
})

test('相手が処理中なら預かりに並び、回ったターンからも送れない（預かりが送り元の印を持ち越す）', async () => {
  runner.started.length = 0
  turn('A1@r')
  turn('B1@r')
  try {
    const res = await send('A1@r', 'B1@r', '終わったら見て')
    assert.equal(res.status, 202)
    assert.equal(((await res.json()) as AgentSendResponse).via, 'queued')
    assert.equal(runner.started.length, 0)
  } finally {
    idle('A1@r')
    idle('B1@r')
  }
  // B1 の前のターンが終わった。ポーリングのついでに預かりが回る
  const list = (await (await fetch(`${base}/api/sessions?days=7`)).json()) as SessionsResponse
  assert.equal(list.queued['B1@r'], undefined)
  assert.equal(runner.started.at(-1)?.id, 'B1@r')
  assert.match(runner.started.at(-1)!.cmd.text, /^【SAI】/)
  turn('B1@r')
  try {
    assert.equal((await send('B1@r', 'A1@r', '頼み返す')).status, 429, '預かりから回ったターンも、メッセージで起動したターン')
  } finally {
    idle('B1@r')
  }
  await humanReply('B1@r')
  idle('B1@r')
})

test('相手のエージェントの 5 時間の枠が 80% を超えていたら送らない（429）。取れなければ・戻っていれば止めない（#311）', async () => {
  runner.started.length = 0
  turn('A1@r')
  try {
    const later = Date.now() / 1000 + 3600
    usage.value = { claude: { primary: { used_percent: 85, window_minutes: 300, resets_at: later }, at: '' } }
    const res = await send('A1@r', 'B1@r', '見て')
    assert.equal(res.status, 429)
    assert.match(((await res.json()) as { error: string }).error, /5 時間の枠が 85%/)
    assert.equal(runner.started.length, 0, '止めたら起動しない')
    usage.value = { claude: { primary: { used_percent: 85, window_minutes: 300, resets_at: Date.now() / 1000 - 60 }, at: '' } }
    assert.equal((await send('A1@r', 'B1@r', '枠が戻った')).status, 202)
    usage.value = {}
    assert.equal((await send('A1@r', 'B1@r', '取れない')).status, 202)
  } finally {
    usage.value = {}
    idle('A1@r')
  }
  await humanReply('B1@r')
  idle('B1@r')
})

test('1 ターンで相手に読み直させる量の予算を超える相手には送らない（429）。次のターンでは数え直す（#311）', async () => {
  contexts.set('B1@r', 2_000_000)
  turn('A1@r', 'budget-a')
  try {
    const first = await send('A1@r', 'B1@r', '一回目')
    assert.equal(first.status, 202)
    const body = (await first.json()) as AgentSendResponse
    assert.deepEqual([body.context_tokens, body.read_tokens, body.read_budget], [2_000_000, 2_000_000, 3_000_000])
    const second = await send('A1@r', 'B1@r', '二回目')
    assert.equal(second.status, 429)
    assert.match(((await second.json()) as { error: string }).error, /予算を超えます/)
    turn('A1@r', 'budget-b')
    assert.equal((await send('A1@r', 'B1@r', '次のターン')).status, 202)
  } finally {
    contexts.delete('B1@r')
    idle('A1@r')
  }
  await humanReply('B1@r')
  idle('B1@r')
})

test('詳細の応答に、そのセッションから別のセッションへのメッセージのようす（往復数・読み直させた量・直近の送り先）が載る（#311）', async () => {
  const detailOf = async (id: string) => (await (await fetch(`${base}/api/sessions/${encodeURIComponent(id)}?days=7`)).json()) as SessionDetailResponse
  assert.equal((await detailOf('C1@r')).agent, undefined, '送ったことが無ければ載らない')
  contexts.set('B1@r', 400_000)
  turn('A1@r', 'activity-turn')
  let messageId = ''
  try {
    messageId = ((await (await send('A1@r', 'B1@r', '見て')).json()) as AgentSendResponse).message_id
    const detail = await detailOf('A1@r')
    assert.equal(detail.agent?.stopped, false)
    assert.deepEqual([detail.agent?.sent, detail.agent?.limit, detail.agent?.read_tokens, detail.agent?.read_budget], [1, AGENT_SEND_MAX, 400_000, 3_000_000])
    assert.deepEqual(detail.agent?.recent[0], { message_id: messageId, to: 'B1@r', to_name: 'レビューして', since: detail.agent!.recent[0]!.since, status: 'pending' })
  } finally {
    contexts.delete('B1@r')
    idle('A1@r')
  }
  const settledDetail = await detailOf('A1@r')
  assert.deepEqual([settledDetail.agent?.sent, settledDetail.agent?.read_tokens], [0, 0], 'ターンを回していなければ数は 0（直近の送り先は残る）')
  assert.equal(settledDetail.agent?.recent[0]?.message_id, messageId)
  await humanReply('B1@r')
  idle('B1@r')
})

test('人が「送信を止める」を押したら送らない（429）。預かりに並んでいたそのセッションからの分も取り消す。「再開する」で戻る（#311）', async () => {
  const post = (path: string, headers: Record<string, string> = {}) => fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: '{}' })
  turn('A1@r', 'stop-turn')
  turn('B1@r')
  try {
    const queued = await send('A1@r', 'B1@r', '終わったら見て')
    assert.equal(((await queued.json()) as AgentSendResponse).via, 'queued')
    assert.equal((await post('/api/sessions/A1%40r/agent/stop', { Origin: 'http://evil.local:8787' })).status, 403, '画面からの口なので同一オリジンのみ')
    const revBefore = ((await (await fetch(`${base}/api/sessions/A1%40r?days=7`)).json()) as SessionDetailResponse).rev

    const stopped = await post('/api/sessions/A1%40r/agent/stop')
    assert.equal(stopped.status, 200)
    const body = (await stopped.json()) as AgentStopResponse
    assert.equal(body.agent.stopped, true)
    assert.equal(body.cancelled, 1, '預かりに並んでいた、このセッションからのメッセージを取り消す')
    const list = (await (await fetch(`${base}/api/sessions?days=7`)).json()) as SessionsResponse
    assert.equal(list.queued['B1@r'], undefined)
    const detail = (await (await fetch(`${base}/api/sessions/A1%40r?days=7`)).json()) as SessionDetailResponse
    assert.notEqual(detail.rev, revBefore, '止めたら rev が変わる（画面が拾う）')
    assert.equal(detail.agent?.stopped, true)

    const refused = await send('A1@r', 'B1@r', 'もう一回')
    assert.equal(refused.status, 429)
    assert.match(((await refused.json()) as { error: string }).error, /止めています/)
    assert.equal((await fetch(`${base}/api/sessions/A1%40r/agent/stop`)).status, 405, 'GET では止められない')

    const resumed = await post('/api/sessions/A1%40r/agent/resume')
    assert.equal(resumed.status, 200)
    assert.equal(((await resumed.json()) as AgentStopResponse).agent.stopped, false)
    const resumedDetail = (await (await fetch(`${base}/api/sessions/A1%40r?days=7`)).json()) as SessionDetailResponse
    assert.notEqual(resumedDetail.rev, detail.rev, '再開も rev を変える（預かりは動かないので、止めた・再開したそのものを rev に混ぜていないと画面が拾わない）')
  } finally {
    idle('A1@r')
    idle('B1@r')
  }
  turn('A1@r', 'stop-turn-2')
  try {
    assert.equal((await send('A1@r', 'B1@r', '再開した')).status, 202)
  } finally {
    idle('A1@r')
  }
  await humanReply('B1@r')
  idle('B1@r')
})

test('sai_wait: 相手のそのターンの完了の行が届いたら返答を切って返す。まだなら 202、送った本人以外は 404', async () => {
  turn('A1@r')
  let messageId = ''
  let delivered = ''
  try {
    const body = (await (await send('A1@r', 'B1@r', 'まとめて')).json()) as AgentSendResponse
    messageId = body.message_id
    delivered = runner.started.at(-1)!.cmd.text
  } finally {
    idle('A1@r')
  }
  const wait = (from: string) => agent(`/api/agent/wait?from=${encodeURIComponent(from)}&message_id=${messageId}`)
  const pending = await wait('A1@r')
  assert.equal(pending.status, 202)
  assert.equal(((await pending.json()) as AgentWaitResponse).status, 'pending')
  assert.equal((await wait('B1@r')).status, 404, '送った本人だけが待てる')

  await appendFile(feedFile, JSON.stringify(row(new Date(), 'B1', { repo: 'r', cwd: work, project: 'o/r', user_text: delivered, text: 'あ'.repeat(5000) })) + '\n')
  const done = await wait('A1@r')
  assert.equal(done.status, 200)
  const result = (await done.json()) as AgentWaitResponse
  assert.equal(result.status, 'done')
  assert.ok(result.text!.startsWith('あ'.repeat(4000)))
  assert.match(result.text!, /あと 1000 字を省略/, '長い返答は切って、送り元の会話を膨らませない')
  await humanReply('B1@r')
  idle('B1@r')
})

test('sai_wait: 相手のターンが失敗したら failed と理由を返す', async () => {
  turn('A1@r')
  let body: AgentSendResponse
  try {
    body = (await (await send('A1@r', 'B1@r', '失敗する')).json()) as AgentSendResponse
  } finally {
    idle('A1@r')
  }
  turn('B1@r', 'failed-turn', { text: runner.started.at(-1)!.cmd.text, failed: { code: 3, tail: 'boom' } })
  try {
    const res = await agent(`/api/agent/wait?from=A1%40r&message_id=${body.message_id}`)
    assert.equal(res.status, 200)
    const result = (await res.json()) as AgentWaitResponse
    assert.equal(result.status, 'failed')
    assert.match(result.error ?? '', /終了コード 3: boom/)
  } finally {
    idle('B1@r')
  }
})
