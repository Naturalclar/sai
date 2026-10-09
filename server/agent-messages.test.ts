// セッション同士のメッセージ（#310 / #311）。本物の createApp にエージェント用の口を叩かせる。
// 一覧の fixture（app.test.ts）に行を足すと他のテストの件数が変わるので、アプリごと別に立てる
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import type { Server } from 'node:http'
import { appendFile, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AGENT_SEND_MAX, HANDED_MARK, splitHandedReplies, STEERED_NOTE, WAKE_NOTE } from '../shared/agentMessages.ts'
import type {
  AgentSendManyResponse,
  AgentSendResponse,
  AgentSessionsResponse,
  AgentStopResponse,
  AgentWaitResponse,
  SettingsResponse,
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
import { PNG } from './meta/icons.test.ts'
import { FeedStore } from './rows/store.ts'

let dir: string
let work: string
/** B1 の worktree（#564 の重なりを見るため、A1 と別にする） */
let work2: string
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
  /** 入力の口に足した分（#386 / #594）。本物と同じく `interruptible` が付いているときだけ受ける */
  steered: { id: string; text: string }[] = []
  steer(id: string, text: string) {
    if (!this.busy.get(id)?.interruptible) return false
    this.steered.push({ id, text })
    return true
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
/**
 * git の偽物（#564）。worktree ごとに変わっているファイルを返す。base は見つからない扱いで、未コミットの差分だけで答える
 */
const changedFiles = new Map<string, string[]>()
const changed = {
  async run(cwd: string, args: string[]) {
    if (args[0] === 'rev-parse' && args[1] === '--show-toplevel') return `${cwd}\n`
    if (args[0] === 'diff' && args[1] === '--numstat') return (changedFiles.get(cwd) ?? []).map((p) => `1\t0\t${p}`).join('\n')
    if (args[0] === 'ls-files') return ''
    throw new Error(`unused: ${args.join(' ')}`)
  },
}
const now = new Date()
const minutesAgo = (n: number) => new Date(now.getTime() - n * 60_000)

before(async () => {
  // このサーバのマシン名（#114）。R1 だけ別のマシンにする
  process.env.AGENT_FEED_HOST = 'testmac'
  dir = await mkdtemp(join(tmpdir(), 'sai-agent-'))
  work = await mkdtemp(join(tmpdir(), 'sai-agent-work-'))
  work2 = await mkdtemp(join(tmpdir(), 'sai-agent-work2-'))
  // 変わっているファイル（#564）。結果は (cwd, last_turn_ts) で 30 秒覚えられるので、最初から決めておく
  changedFiles.set(work, ['server/app.ts', 'shared/types.ts', 'CLAUDE.md', 'docs/internals/agents.md'])
  changedFiles.set(work2, ['server/app.ts', 'web/src/App.tsx', 'CLAUDE.md', 'docs/internals/agents.md', 'shared/types.ts'])
  feedFile = join(dir, `${localDate(now.toISOString())}.jsonl`)
  await writeFile(
    feedFile,
    [
      row(minutesAgo(9), 'A1', { repo: 'r', cwd: work, project: 'o/r', user_text: '実装して' }),
      row(minutesAgo(8), 'B1', { repo: 'r', cwd: work2, project: 'o/r', user_text: 'レビューして', text: 'レビューしました' }),
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
    changed,
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
  await rm(work2, { recursive: true, force: true })
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
    assert.deepEqual(body.sessions[0], { id: 'B1@r', name: 'レビューして', project: 'o/r', branch: body.sessions[0]!.branch, agent: 'claude', busy: true, last_text: 'レビューしました', context_tokens: 0, overlap: ['server/app.ts', 'shared/types.ts'], overlap_more: 0 }, 'どちらの worktree でも変わっているファイル。CLAUDE.md と docs/ は数えない（#564）')
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

test(`その場で送れるのは 1 ターンに ${AGENT_SEND_MAX} 回まで（超えた分は預かる。#727）。次のターンでは数え直す（#311）`, async () => {
  turn('A1@r', 'turn-a')
  try {
    for (let i = 0; i < AGENT_SEND_MAX; i++) assert.equal(((await (await send('A1@r', 'B1@r', `${i}`)).json()) as AgentSendResponse).held, undefined, `${i + 1} 回目`)
    const res = await send('A1@r', 'B1@r', 'もう一回')
    assert.equal(res.status, 202, '断らずに預かる')
    const body = (await res.json()) as AgentSendResponse
    assert.deepEqual([body.held, body.sent, body.limit], [true, AGENT_SEND_MAX, AGENT_SEND_MAX], 'その場で送った回数は増えない')
    // 預かりを片付けてから次のターンへ（預かりが残っている間は、次のターンの送信も後ろに並ぶ）
    await stopSending('A1@r', 'stop')
    await stopSending('A1@r', 'resume')
    turn('A1@r', 'turn-b')
    assert.equal(((await (await send('A1@r', 'B1@r', '次のターン')).json()) as AgentSendResponse).held, undefined)
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

test('1 ターンで相手に読み直させる量の予算を超える分は預かり（#727）、依頼の予算を超えたら断る（429）。次のターンでは数え直す（#311）', async () => {
  contexts.set('B1@r', 2_000_000)
  turn('A1@r', 'budget-a')
  try {
    const first = await send('A1@r', 'B1@r', '一回目')
    assert.equal(first.status, 202)
    const body = (await first.json()) as AgentSendResponse
    assert.deepEqual([body.context_tokens, body.read_tokens, body.read_budget], [2_000_000, 2_000_000, 3_000_000])
    // 200 万 + 200 万は 1 ターンの予算（300 万）を超える → その場では送らず預かる。数えた量は増えない
    const second = (await (await send('A1@r', 'B1@r', '二回目')).json()) as AgentSendResponse
    assert.deepEqual([second.held, second.read_tokens], [true, 2_000_000])
    // 依頼の予算（600 万）ちょうどまでは預かり、超えたら 1 件も預からずに断る
    assert.equal(((await (await send('A1@r', 'B1@r', '三回目')).json()) as AgentSendResponse).held, true)
    const fourth = await send('A1@r', 'B1@r', '四回目')
    assert.equal(fourth.status, 429)
    assert.match(((await fourth.json()) as { error: string }).error, /この依頼で相手に読み直させる量の合計が予算を超えます/)
    await stopSending('A1@r', 'stop')
    await stopSending('A1@r', 'resume')
    turn('A1@r', 'budget-b')
    assert.equal(((await (await send('A1@r', 'B1@r', '次のターン')).json()) as AgentSendResponse).held, undefined)
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

  await appendFile(feedFile, JSON.stringify(row(new Date(), 'B1', { repo: 'r', cwd: work2, project: 'o/r', user_text: delivered, text: 'あ'.repeat(5000) })) + '\n')
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

test('送り元が待たずにターンを終えても、相手の返答が送り元の詳細の応答に載る。rev も変わる（#588）', async () => {
  turn('A1@r')
  let messageId = ''
  let delivered = ''
  try {
    const body = (await (await send('A1@r', 'B1@r', '着手して')).json()) as AgentSendResponse
    messageId = body.message_id
    delivered = runner.started.at(-1)!.cmd.text
  } finally {
    // 送り元は待たない（sai_wait を呼ばずにターンを終える）
    idle('A1@r')
  }
  assert.match(delivered, /返答として送り元の画面に出て、送り元の次のターンの頭にも届きます/, '見出しは返答がどこへ行くかを書く（#594）')
  const detail = async () => (await (await fetch(`${base}/api/sessions/A1%40r`)).json()) as SessionDetailResponse
  const before = await detail()
  assert.equal(before.agent_replies?.some((r) => r.agent_reply?.message_id === messageId) ?? false, false, 'まだ返っていない')
  await appendFile(feedFile, JSON.stringify(row(new Date(), 'B1', { repo: 'r', cwd: work2, project: 'o/r', user_text: delivered, text: '着手しました。PR を出しました' })) + '\n')
  const after = await detail()
  assert.notEqual(after.rev, before.rev, '返答が届いたら画面が描き直す')
  const reply = after.agent_replies?.find((r) => r.agent_reply?.message_id === messageId)
  assert.equal(reply?.text, '着手しました。PR を出しました')
  assert.equal(reply?.session, 'B1', '行は相手のセッションのもの')
  assert.equal(reply?.agent_reply?.to_name, '#r', '表示名が無ければ worktree 名（題名は届けた見出しになっているので使わない）')
  assert.equal(reply?.agent_reply?.to_icon, undefined, 'アイコンを付けていない相手は印に載せない（画面は頭文字）')
  // 相手がアイコンを付けたら、返答の印にも載る（#666）。rev も変わる（送り元の画面が描き直す）
  const iconOf = (id: string, init: RequestInit) => fetch(`${base}/api/sessions/${encodeURIComponent(id)}/icon`, { headers: { Origin: base }, ...init })
  assert.equal((await iconOf('B1@r', { method: 'PUT', body: PNG })).status, 200)
  const withIcon = await detail()
  assert.notEqual(withIcon.rev, after.rev)
  assert.match(withIcon.agent_replies?.find((r) => r.agent_reply?.message_id === messageId)?.agent_reply?.to_icon ?? '', /^\/api\/sessions\/B1%40r\/icon\?v=/)
  assert.equal((await iconOf('B1@r', { method: 'DELETE' })).status, 200)
  assert.equal((await detail()).agent_replies?.find((r) => r.agent_reply?.message_id === messageId)?.agent_reply?.to_icon, undefined)
  // 受け取った側の詳細には載せない（自分が送ったメッセージではない）
  assert.equal(((await (await fetch(`${base}/api/sessions/B1%40r`)).json()) as SessionDetailResponse).agent_replies?.some((r) => r.agent_reply?.message_id === messageId) ?? false, false)
  await humanReply('B1@r')
  idle('B1@r')
})

test('待たずに終えた送り元の次のターンの頭に、まだ渡していない返答を足す。2 回目には足さない。渡したことは画面と立て直しに残る（#594）', async () => {
  turn('A1@r')
  let messageId = ''
  let delivered = ''
  let failedId = ''
  try {
    messageId = ((await (await send('A1@r', 'B1@r', '調べて')).json()) as AgentSendResponse).message_id
    delivered = runner.started.at(-1)!.cmd.text
    // もう 1 通は返答がまだ無い（足さない）
  } finally {
    idle('A1@r')
  }
  await humanReply('B1@r')
  idle('B1@r')
  turn('A1@r')
  try {
    failedId = ((await (await send('A1@r', 'B1@r', 'まだ返らない')).json()) as AgentSendResponse).message_id
  } finally {
    idle('A1@r')
  }
  idle('B1@r')
  await appendFile(feedFile, JSON.stringify(row(new Date(), 'B1', { repo: 'r', cwd: work2, project: 'o/r', user_text: delivered, text: 'PR #9 を出しました' })) + '\n')

  // 人が送り元に次を送る → 本文の頭に返答が 1 件足される
  runner.started.length = 0
  await humanReply('A1@r')
  const first = runner.started.at(-1)!.cmd.text
  assert.ok(first.startsWith(HANDED_MARK), '本文の頭に足す')
  assert.match(first, new RegExp(`message_id: ${messageId}`))
  assert.match(first, /PR #9 を出しました/)
  assert.doesNotMatch(first, new RegExp(failedId), '返答がまだ無い依頼は足さない')
  assert.ok(first.endsWith('人から'), '人が打った文はそのまま最後に')
  // 前のテスト（#588）で待たずに終えた返答も、まだ渡していないので一緒に足される
  assert.equal(splitHandedReplies(first).text, '人から', '画面は塊を外して見せる')
  assert.equal(splitHandedReplies(first).handed, 2)

  // 画面の返答のバブルに「渡した」が出る
  const detail = (await (await fetch(`${base}/api/sessions/A1%40r`)).json()) as SessionDetailResponse
  assert.ok(detail.agent_replies?.find((r) => r.agent_reply?.message_id === messageId)?.agent_reply?.handed_at, '渡した時刻が載る')

  // 2 回目には足さない。渡したことはファイルに残る（立て直しても残る）
  await humanReply('A1@r')
  assert.equal(runner.started.at(-1)!.cmd.text, '人から')
  const saved = JSON.parse(await readFile(join(dir, 'agent-messages.json'), 'utf-8')) as { messages: { message_id: string; handed_at?: string }[] }
  assert.ok(saved.messages.find((m) => m.message_id === messageId)?.handed_at)
  assert.equal(saved.messages.find((m) => m.message_id === failedId)?.handed_at, undefined, 'まだ返っていないものは渡していない')
  idle('A1@r')
})

test('sai_wait で受け取った返答は、次のターンの頭に重ねて足さない（#594）', async () => {
  turn('A1@r')
  let messageId = ''
  let delivered = ''
  try {
    messageId = ((await (await send('A1@r', 'B1@r', '短い質問')).json()) as AgentSendResponse).message_id
    delivered = runner.started.at(-1)!.cmd.text
  } finally {
    idle('A1@r')
  }
  idle('B1@r')
  await appendFile(feedFile, JSON.stringify(row(new Date(), 'B1', { repo: 'r', cwd: work2, project: 'o/r', user_text: delivered, text: 'はい' })) + '\n')
  assert.equal((await agent(`/api/agent/wait?from=A1%40r&message_id=${messageId}`)).status, 200)
  await humanReply('A1@r')
  assert.doesNotMatch(runner.started.at(-1)!.cmd.text, new RegExp(messageId))
  idle('A1@r')
})

test('相手のターンが失敗した依頼は、次のターンの頭に 1 行で知らせる（#594）', async () => {
  turn('A1@r')
  let body: AgentSendResponse
  try {
    body = (await (await send('A1@r', 'B1@r', '落ちる依頼')).json()) as AgentSendResponse
  } finally {
    idle('A1@r')
  }
  turn('B1@r', 'failed-594', { text: runner.started.at(-1)!.cmd.text, failed: { code: 2, tail: 'だめ' } })
  try {
    await humanReply('A1@r')
    assert.match(runner.started.at(-1)!.cmd.text, new RegExp(`message_id: ${body.message_id}）への依頼は失敗しました: 終了コード 2: だめ`))
  } finally {
    idle('A1@r')
    idle('B1@r')
  }
})

test('返答を足さない場面: 別のセッションから届いたメッセージのターン・/ や $ で始まる指示（#596 のレビュー）', async () => {
  // A1 に未渡しの返答を 1 件作る
  turn('A1@r')
  let delivered = ''
  let messageId = ''
  try {
    messageId = ((await (await send('A1@r', 'B1@r', '足さない場面の準備')).json()) as AgentSendResponse).message_id
    delivered = runner.started.at(-1)!.cmd.text
  } finally {
    idle('A1@r')
  }
  await humanReply('B1@r')
  idle('B1@r')
  await appendFile(feedFile, JSON.stringify(row(new Date(), 'B1', { repo: 'r', cwd: work2, project: 'o/r', user_text: delivered, text: '返しました' })) + '\n')

  // B1 から A1 へのメッセージで A1 のターンが起きる。見出しが頭のまま（塊を足すと、B1 が返答を引き当てられなくなる）
  turn('B1@r')
  try {
    assert.equal((await send('B1@r', 'A1@r', 'これ見て')).status, 202)
    assert.ok(runner.started.at(-1)!.cmd.text.startsWith('【SAI】'), '届けた見出しが頭')
  } finally {
    idle('B1@r')
    idle('A1@r')
  }
  // スキル・コマンドは頭に無いと CLI が展開しないので足さない
  const slash = await fetch(`${base}/api/sessions/A1%40r/reply`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: '/merge 596' }) })
  assert.equal(slash.status, 202)
  assert.equal(runner.started.at(-1)!.cmd.text, '/merge 596')
  idle('A1@r')
  // 未渡しのまま残っていて、次のふつうの返信で渡る
  await humanReply('A1@r')
  assert.match(runner.started.at(-1)!.cmd.text, new RegExp(`message_id: ${messageId}`))
  idle('A1@r')
})

test('返答を足したターンが失敗したら「渡した」を取り消し、次のターンでもう一度足す。画面に出す処理中の本文からは塊を外す（#596 のレビュー）', async () => {
  turn('A1@r')
  let delivered = ''
  let messageId = ''
  try {
    messageId = ((await (await send('A1@r', 'B1@r', '失敗するターンの準備')).json()) as AgentSendResponse).message_id
    delivered = runner.started.at(-1)!.cmd.text
  } finally {
    idle('A1@r')
  }
  await humanReply('B1@r')
  idle('B1@r')
  await appendFile(feedFile, JSON.stringify(row(new Date(), 'B1', { repo: 'r', cwd: work2, project: 'o/r', user_text: delivered, text: '返しました 2' })) + '\n')

  await humanReply('A1@r')
  const carried = runner.started.at(-1)!.cmd.text
  assert.match(carried, new RegExp(`message_id: ${messageId}`))
  // 回っている間、画面に出す本文は人が打った文だけ（入力欄への戻し・一覧の 2 行目がこれを使う）
  turn('A1@r', new Date().toISOString(), { text: carried })
  const running = (await (await fetch(`${base}/api/sessions?days=7`)).json()) as SessionsResponse
  assert.equal(running.replying['A1@r']?.text, '人から')
  // そのターンが失敗した → 渡していないことに戻る
  turn('A1@r', new Date().toISOString(), { text: carried, failed: { code: 1, tail: '落ちた' } })
  await fetch(`${base}/api/sessions?days=7`)
  idle('A1@r')
  await humanReply('A1@r')
  assert.match(runner.started.at(-1)!.cmd.text, new RegExp(`message_id: ${messageId}`), '読まれていないので、もう一度足す')
  idle('A1@r')
})

const poll = () => fetch(`${base}/api/sessions?days=7`)
const sendWake = (from: string, to: string, text: string) => agent('/api/agent/send', { method: 'POST', body: JSON.stringify({ from, to, text, wake: true }) })

test('送り元がまだ回っていれば、届いた返答を入力の口からその場で足す。次のターンには重ねない（#594 の 2）', async () => {
  // 前のテストまでの未渡しを空にしておく
  await humanReply('A1@r')
  idle('A1@r')
  runner.steered.length = 0
  const since = new Date().toISOString()
  turn('A1@r', since, { interruptible: true })
  let messageId = ''
  let delivered = ''
  try {
    messageId = ((await (await send('A1@r', 'B1@r', '回っている間に返して')).json()) as AgentSendResponse).message_id
    delivered = runner.started.at(-1)!.cmd.text
    await poll()
    assert.equal(runner.steered.length, 0, 'まだ返っていない')
    await humanReply('B1@r')
    idle('B1@r')
    await appendFile(feedFile, JSON.stringify(row(new Date(), 'B1', { repo: 'r', cwd: work2, project: 'o/r', user_text: delivered, text: '途中で返しました' })) + '\n')
    await poll()
    assert.equal(runner.steered.length, 1)
    assert.equal(runner.steered[0]!.id, 'A1@r')
    assert.ok(runner.steered[0]!.text.startsWith(HANDED_MARK))
    assert.match(runner.steered[0]!.text, new RegExp(`message_id: ${messageId}`))
    assert.ok(runner.steered[0]!.text.endsWith(STEERED_NOTE))
    await poll()
    assert.equal(runner.steered.length, 1, '2 回は足さない')
  } finally {
    idle('A1@r')
  }
  await humanReply('A1@r')
  assert.equal(runner.started.at(-1)!.cmd.text, '人から', '次のターンには重ねない')
  idle('A1@r')
})

test('wake を付けて送ると、返答がそろったときに送り元を 1 回だけ起こす。起こしたターンからは送れない（#594 の 3）', async () => {
  const since = new Date().toISOString()
  turn('A1@r', since)
  let messageId = ''
  let delivered = ''
  try {
    const res = await sendWake('A1@r', 'B1@r', '返答を受けて続ける')
    assert.equal(res.status, 202)
    messageId = ((await res.json()) as AgentSendResponse).message_id
    delivered = runner.started.at(-1)!.cmd.text
    await humanReply('B1@r')
    idle('B1@r')
    await appendFile(feedFile, JSON.stringify(row(new Date(), 'B1', { repo: 'r', cwd: work2, project: 'o/r', user_text: delivered, text: 'そろいました' })) + '\n')
    runner.started.length = 0
    await poll()
    assert.equal(runner.started.length, 0, '送ったターンがまだ回っている間は起こさない')
  } finally {
    idle('A1@r')
  }
  await poll()
  assert.equal(runner.started.length, 1, '1 回だけ起こす')
  const woke = runner.started[0]!
  assert.equal(woke.id, 'A1@r')
  assert.ok(woke.cmd.text.startsWith(HANDED_MARK))
  assert.match(woke.cmd.text, new RegExp(`message_id: ${messageId}`))
  assert.ok(woke.cmd.text.endsWith(WAKE_NOTE))
  await poll()
  assert.equal(runner.started.length, 1, 'ポーリングのたびに起こさない')
  // 起こしたターンからは送れない（連鎖 1 段）
  turn('A1@r')
  try {
    const chained = await send('A1@r', 'B1@r', 'さらに頼む')
    assert.equal(chained.status, 429)
  } finally {
    await humanReply('A1@r')
    idle('A1@r')
  }
})

test('wake: 人が「送信を止める」にしていれば起こさない。返答は未渡しのまま次のターンの頭で渡る（#594 の 3）', async () => {
  turn('A1@r', new Date().toISOString())
  let messageId = ''
  let delivered = ''
  try {
    messageId = ((await (await sendWake('A1@r', 'B1@r', '止めている間の依頼')).json()) as AgentSendResponse).message_id
    delivered = runner.started.at(-1)!.cmd.text
  } finally {
    idle('A1@r')
  }
  await humanReply('B1@r')
  idle('B1@r')
  const stop = (what: 'stop' | 'resume') => fetch(`${base}/api/sessions/A1%40r/agent/${what}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
  assert.equal((await stop('stop')).status, 200)
  try {
    await appendFile(feedFile, JSON.stringify(row(new Date(), 'B1', { repo: 'r', cwd: work2, project: 'o/r', user_text: delivered, text: '止まっている間の返答' })) + '\n')
    runner.started.length = 0
    await poll()
    assert.equal(runner.started.length, 0, '起こさない')
  } finally {
    await stop('resume')
  }
  // 再開したら起きる（返答はそろっている）
  await poll()
  assert.equal(runner.started.length, 1)
  assert.match(runner.started[0]!.cmd.text, new RegExp(`message_id: ${messageId}`))
  await humanReply('A1@r')
  idle('A1@r')
})

test('sai_wait で待っている返答は、入力の口からは足さない（同じターンで 2 回読ませない。#607 のレビュー）', async () => {
  await humanReply('A1@r')
  idle('A1@r')
  runner.steered.length = 0
  turn('A1@r', new Date().toISOString(), { interruptible: true })
  try {
    const messageId = ((await (await send('A1@r', 'B1@r', '待って受け取る')).json()) as AgentSendResponse).message_id
    const delivered = runner.started.at(-1)!.cmd.text
    await humanReply('B1@r')
    idle('B1@r')
    // 送り元は sai_wait で待っている（まだ返っていないので 202）
    assert.equal((await agent(`/api/agent/wait?from=A1%40r&message_id=${messageId}`)).status, 202)
    await appendFile(feedFile, JSON.stringify(row(new Date(), 'B1', { repo: 'r', cwd: work2, project: 'o/r', user_text: delivered, text: '待っていた返答' })) + '\n')
    await poll()
    assert.equal(runner.steered.length, 0, '待っている分は足さない')
    assert.equal((await agent(`/api/agent/wait?from=A1%40r&message_id=${messageId}`)).status, 200, 'sai_wait が受け取る')
    await poll()
    assert.equal(runner.steered.length, 0, '受け取ったものは渡した扱い')
  } finally {
    idle('A1@r')
  }
})

test('途中で足したターンが失敗したら「渡した」を取り消し、次のターンの頭でもう一度足す（#607 のレビュー）', async () => {
  runner.steered.length = 0
  const since = new Date().toISOString()
  turn('A1@r', since, { interruptible: true })
  let messageId = ''
  try {
    messageId = ((await (await send('A1@r', 'B1@r', '足したあと落ちる')).json()) as AgentSendResponse).message_id
    const delivered = runner.started.at(-1)!.cmd.text
    await humanReply('B1@r')
    idle('B1@r')
    await appendFile(feedFile, JSON.stringify(row(new Date(), 'B1', { repo: 'r', cwd: work2, project: 'o/r', user_text: delivered, text: '落ちる前の返答' })) + '\n')
    await new Promise((r) => setTimeout(r, 10))
    await poll()
    assert.equal(runner.steered.length, 1)
    // そのターンが失敗した
    turn('A1@r', since, { failed: { code: 1, tail: '落ちた' } })
    await poll()
  } finally {
    idle('A1@r')
  }
  await humanReply('A1@r')
  assert.match(runner.started.at(-1)!.cmd.text, new RegExp(`message_id: ${messageId}`), '読まれていないので、もう一度足す')
  idle('A1@r')
})

test('wake: 預かりに並んだ「起こす」を人が取り消したら、返答は未渡しのまま次のターンの頭で渡る（#607 のレビュー）', async () => {
  const sent = new Date().toISOString()
  turn('A1@r', sent)
  let messageId = ''
  let delivered = ''
  try {
    messageId = ((await (await sendWake('A1@r', 'B1@r', '取り消される依頼')).json()) as AgentSendResponse).message_id
    delivered = runner.started.at(-1)!.cmd.text
  } finally {
    idle('A1@r')
  }
  await humanReply('B1@r')
  idle('B1@r')
  // 送り元は別のターンを回している → 起こすのは預かりに並ぶ
  turn('A1@r', 'another-turn')
  await appendFile(feedFile, JSON.stringify(row(new Date(), 'B1', { repo: 'r', cwd: work2, project: 'o/r', user_text: delivered, text: '取り消される返答' })) + '\n')
  runner.started.length = 0
  await poll()
  const queued = ((await (await poll()).json()) as SessionsResponse).queued['A1@r']
  assert.equal(queued?.items.length, 1, '預かりに 1 件だけ並ぶ（ポーリングを重ねても増えない）')
  assert.ok(queued!.items[0]!.text.endsWith(WAKE_NOTE))
  // 人が取り消す
  assert.equal((await fetch(`${base}/api/sessions/A1%40r/queue/${queued!.items[0]!.queue_id}`, { method: 'DELETE' })).status, 200)
  await poll()
  idle('A1@r')
  await poll()
  assert.equal(runner.started.length, 0, '取り消したので起こさない')
  await humanReply('A1@r')
  assert.match(runner.started.at(-1)!.cmd.text, new RegExp(`message_id: ${messageId}`), '未渡しのまま残っていて、次のターンの頭で渡る')
  idle('A1@r')
})


// ---- 着手の依頼は要約（/compact）してから始める（#624）

const sendWith = (from: string, to: string, text: string, over: Record<string, unknown>) => agent('/api/agent/send', { method: 'POST', body: JSON.stringify({ from, to, text, ...over }) })
/** 預かりに残ったものを消して、止まった預かりを戻す（次のテストに持ち越さない） */
const clearQueue = async (id: string) => {
  const list = (await (await poll()).json()) as SessionsResponse
  for (const item of list.queued[id]?.items ?? []) await fetch(`${base}/api/sessions/${encodeURIComponent(id)}/queue/${item.queue_id}`, { method: 'DELETE', headers: { Origin: base } })
  await fetch(`${base}/api/sessions/${encodeURIComponent(id)}/queue/resume`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base }, body: '{}' })
}

test('sai_send: 1 行目が着手の形で相手が要約できるなら、/compact のターンを先に回し、本文は見出し付きのまま預かりから回る。返答も引き当たる（#624）', async () => {
  runner.started.length = 0
  contexts.set('B1@r', 500_000)
  turn('A1@r')
  let messageId = ''
  try {
    const res = await send('A1@r', 'B1@r', '#624 に着手してください。\nissue の本文とコメントが正本です。')
    assert.equal(res.status, 202)
    const body = (await res.json()) as AgentSendResponse
    messageId = body.message_id
    assert.equal(body.via, 'compact')
    assert.equal(body.context_tokens, 500_000, '予算の数え方は今のまま（要約の前の大きさを足す）')
    assert.equal(runner.started.length, 1, '起こしたのは要約のターンだけ')
    const first = runner.started[0]!.cmd
    assert.equal(first.compact, true)
    assert.match(first.text, /^\/compact 次は「#624 に着手してください。」に取りかかる/, '指示は見出しを付ける前の、送り元が書いた 1 行目から')
    assert.ok(!first.text.includes('【SAI】'))
  } finally {
    idle('A1@r')
  }
  // 要約が回っている間は本文を回さない
  runner.busy.set('B1@r', { since: new Date().toISOString(), text: '/compact …', compact: true })
  await poll()
  assert.equal(runner.started.length, 1)
  // 要約が終わったら、預かりが本文を回す（見出しの id は本文に残る）
  idle('B1@r')
  await poll()
  assert.equal(runner.started.length, 2)
  const delivered = runner.started[1]!.cmd.text
  assert.match(delivered, new RegExp(`^【SAI】#o/r の「実装して」からのメッセージです（id: ${messageId}）`))
  assert.ok(delivered.endsWith('#624 に着手してください。\nissue の本文とコメントが正本です。'))
  assert.equal(runner.started[1]!.cmd.compact, undefined)
  // 本文のターンも、メッセージで起動したターン（連鎖は 1 段まで）
  turn('B1@r')
  try {
    assert.equal((await send('B1@r', 'A1@r', '頼み返す')).status, 429)
  } finally {
    idle('B1@r')
  }
  // 相手の返答が送り元に引き当てられる
  await appendFile(feedFile, JSON.stringify(row(new Date(), 'B1', { repo: 'r', cwd: work2, project: 'o/r', user_text: delivered, text: 'PR を出しました' })) + '\n')
  const done = (await (await agent(`/api/agent/wait?from=${encodeURIComponent('A1@r')}&message_id=${messageId}`)).json()) as AgentWaitResponse
  assert.deepEqual([done.status, done.text], ['done', 'PR を出しました'])
  contexts.delete('B1@r')
  await humanReply('B1@r')
  idle('B1@r')
})

test('sai_send: 着手の形でない本文・1 行目に続きを書いた依頼・小さい相手は要約しない。指定（compact）があれば指定が勝つ（#624）', async () => {
  contexts.set('B1@r', 500_000)
  const viaOf = async (text: string, over: Record<string, unknown> = {}) => {
    runner.started.length = 0
    turn('A1@r')
    try {
      const res = await sendWith('A1@r', 'B1@r', text, over)
      assert.equal(res.status, 202)
      const via = ((await res.json()) as AgentSendResponse).via
      return { via, cmd: runner.started.at(-1)!.cmd }
    } finally {
      idle('A1@r')
      await clearQueue('B1@r')
      await humanReply('B1@r')
      idle('B1@r')
    }
  }
  try {
    assert.equal((await viaOf('この関数はどこから呼ばれていますか？')).via, 'process', '質問は要約しない')
    assert.equal((await viaOf('#589 に着手してください（重い画像の件）。issue が正本です。')).via, 'process', '判定は緩めない（1 行目に続きがあれば当たらない）')
    assert.equal((await viaOf('#624 に着手してください。', { compact: false })).via, 'process', '着手の形でも、false なら要約しない')
    const asked = await viaOf('#592 の調査を進めてください', { compact: true })
    assert.equal(asked.via, 'compact', '着手の形でなくても、true なら要約する')
    assert.match(asked.cmd.text, /^\/compact 次は「#592 の調査を進めてください」/)
    assert.equal((await viaOf('#624 に着手してください。', { compact: 'yes' })).via, 'compact', '真偽値でない指定は無いものとして、判定に任せる')
    contexts.set('B1@r', 100_000)
    assert.equal((await viaOf('#624 に着手してください。')).via, 'process', '文脈が小さい相手は要約しない')
    assert.equal((await viaOf('#624 に着手してください。', { compact: true })).via, 'process', '要約できない相手は、指定してもそのまま')
  } finally {
    contexts.delete('B1@r')
  }
})

test('sai_send: 相手が処理中なら、着手の形でも要約を挟まずに預かりに並ぶ。要約が失敗したら本文は回さず、送り元には失敗と返る（#624）', async () => {
  contexts.set('B1@r', 500_000)
  runner.started.length = 0
  turn('A1@r')
  turn('B1@r')
  try {
    const res = await send('A1@r', 'B1@r', '#624 に着手してください。')
    assert.equal(((await res.json()) as AgentSendResponse).via, 'queued', '画面からの送信と同じ（処理中は預かるだけ）')
    assert.equal(runner.started.length, 0)
    idle('B1@r')
    await poll()
    assert.match(runner.started.at(-1)!.cmd.text, /^【SAI】/, '順番が来たら、要約せずに本文を回す')
    assert.equal(runner.started.at(-1)!.cmd.compact, undefined)
  } finally {
    idle('A1@r')
    idle('B1@r')
  }
  await humanReply('B1@r')
  idle('B1@r')

  runner.started.length = 0
  turn('A1@r')
  try {
    const body = (await (await send('A1@r', 'B1@r', '#624 に着手してください。')).json()) as AgentSendResponse
    assert.equal(body.via, 'compact')
    runner.busy.set('B1@r', { since: new Date().toISOString(), text: '/compact …', compact: true, failed: { code: 1, tail: '要約できなかった' } })
    await poll()
    assert.equal(runner.started.length, 1, '本文は回さない')
    const failed = (await (await agent(`/api/agent/wait?from=${encodeURIComponent('A1@r')}&message_id=${body.message_id}`)).json()) as AgentWaitResponse
    assert.equal(failed.status, 'failed')
  } finally {
    idle('A1@r')
    idle('B1@r')
    contexts.delete('B1@r')
    await clearQueue('B1@r')
  }
  await humanReply('B1@r')
  idle('B1@r')
})

// ---- 宛先を呼び名でも書ける（#625）

test('sai_send: 宛先は id でも呼び名（表示名・worktree 名）でも同じ相手に届く。返事に届いた相手の id と呼び名が出る。回数の歯止めは今のまま（#625）', async () => {
  const meta = await fetch(`${base}/api/sessions/B1%40r/meta`, { method: 'PUT', headers: { 'Content-Type': 'application/json', Origin: base }, body: JSON.stringify({ name: 'SessionA' }) })
  assert.equal(meta.status, 200)
  runner.started.length = 0
  turn('A1@r')
  try {
    for (const to of ['SessionA', '  sessiona ', 'B1@r']) {
      const res = await send('A1@r', to, '見て')
      assert.equal(res.status, 202, to)
      const body = (await res.json()) as AgentSendResponse
      assert.deepEqual([body.to, body.to_name], ['B1@r', 'SessionA'], to)
    }
    assert.equal(runner.started.at(-1)?.id ?? runner.started[0]?.id, 'B1@r')
    assert.equal(((await (await send('A1@r', 'SessionA', '4 回目')).json()) as AgentSendResponse).held, true, '呼び名で送っても 1 ターンの回数に数える（超えた分は預かる。#727）')
    await stopSending('A1@r', 'stop')
    await stopSending('A1@r', 'resume')
    turn('A1@r')
    // worktree 名 `r` には、送れないセッション（別のマシンの R1・合成 ID の S1）も居る。送れる方が 1 つでも名前では当てない（#662 のレビュー）
    const byRepo = await send('A1@r', 'R', '見て')
    assert.equal(byRepo.status, 409)
    assert.match(((await byRepo.json()) as { error: string }).error, /当たる相手が 3 つあります（うち 2 つは送れないセッション。下には送れる方だけ）。[^\n]*\n- B1@r「SessionA」$/)
    // 前方一致・無い名前は当てない。送らずに、送れる相手を返す
    const before = runner.started.length
    for (const to of ['Sess', 'だれか', 'C1@r']) {
      const res = await send('A1@r', to, '見て')
      assert.equal(res.status, 403, to)
      const text = ((await res.json()) as { error: string }).error
      assert.match(text, /送れる相手:\n- B1@r「SessionA」/, to)
      assert.ok(!text.includes('C1@r「'), '別の project のセッションは候補にも出さない')
    }
    assert.equal(runner.started.length, before)
  } finally {
    idle('A1@r')
    await clearQueue('B1@r')
  }
  await humanReply('B1@r')
  idle('B1@r')
})

test('sai_send: 同じ名前の相手が 2 つ居たら、送らずに候補（id と呼び名）を返す（#625）', async () => {
  // 同じ project に、同じ表示名のセッションをもう 1 つ
  await appendFile(feedFile, JSON.stringify(row(new Date(), 'D1', { repo: 'r2', cwd: work2, project: 'o/r', user_text: '別の作業' })) + '\n')
  const meta = await fetch(`${base}/api/sessions/D1%40r2/meta`, { method: 'PUT', headers: { 'Content-Type': 'application/json', Origin: base }, body: JSON.stringify({ name: 'sessiona' }) })
  assert.equal(meta.status, 200)
  runner.started.length = 0
  turn('A1@r')
  try {
    const res = await send('A1@r', 'SessionA', '見て')
    assert.equal(res.status, 409)
    const text = ((await res.json()) as { error: string }).error
    assert.match(text, /「SessionA」に当たる相手が 2 つあります。送っていません/)
    assert.ok(text.includes('- B1@r「SessionA」') && text.includes('- D1@r2「sessiona」'), text)
    assert.equal(runner.started.length, 0)
    // id と worktree 名なら 1 つに決まる
    assert.equal(((await (await send('A1@r', 'D1@r2', '見て')).json()) as AgentSendResponse).to, 'D1@r2')
    assert.equal(((await (await send('A1@r', 'r2', '見て')).json()) as AgentSendResponse).to, 'D1@r2')
  } finally {
    idle('A1@r')
    await clearQueue('D1@r2')
  }
  await humanReply('D1@r2')
  idle('D1@r2')
})

test('返答のバブルの下から人が相手へ送ると、相手のセッションへの人の返信になり、送り元の詳細に 1 行と相手のそのあとの返答が載る（#700）', async () => {
  await clearQueue('B1@r')
  idle('A1@r')
  idle('B1@r')
  const detail = async () => (await (await fetch(`${base}/api/sessions/A1%40r`)).json()) as SessionDetailResponse
  const reply = (to: string, body: unknown, headers: Record<string, string> = {}) =>
    fetch(`${base}/api/sessions/${encodeURIComponent(to)}/reply`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) })
  const before = await detail()
  assert.ok(before.agent_reply_sessions?.some((s) => s.id === 'B1@r'), '返答の相手のセッションが載る（入力欄と判定に使う）')
  const anchor = before.agent_replies!.at(-1)!.ts

  // 形が違えば 400、別オリジンは 403（返信の口の決まりのまま）
  assert.equal((await reply('B1@r', { text: 'マージして', sent_from: 'A1@r' })).status, 400)
  assert.equal((await reply('B1@r', { text: 'マージして', sent_from: { id: 'A1@r', anchor } }, { Origin: 'http://evil.example' })).status, 403)

  runner.started.length = 0
  const res = await reply('B1@r', { text: 'マージして', sent_from: { id: 'A1@r', anchor } })
  assert.equal(res.status, 202)
  assert.deepEqual(runner.started.map((s) => s.id), ['B1@r'], '起動するのは相手だけ（送り元のターンは起こさない）')
  assert.equal(runner.started[0]!.cmd.text, 'マージして', '人の返信のまま（見出しを付けない）')

  const sent = await detail()
  assert.notEqual(sent.rev, before.rev, '送ったら送り元の画面が描き直す')
  const line = sent.agent_followups?.at(-1)
  assert.deepEqual([line?.to, line?.text, line?.anchor, line?.reply_ts], ['B1@r', 'マージして', anchor, undefined])
  assert.equal(line?.to_name, sent.agent_replies!.at(-1)!.agent_reply!.to_name, '呼び名は返答のバブルと同じ')

  // 相手が別のターン（入力が違う）を先に終えても当てない。送った文で回ったターンの返答だけを当てる
  const later = (ms: number) => new Date(Date.now() + ms)
  await appendFile(feedFile, JSON.stringify(row(later(1000), 'B1', { repo: 'r', cwd: work2, project: 'o/r', user_text: '端末で打った別の入力', text: '別のターン' })) + '\n')
  assert.equal((await detail()).agent_followups?.at(-1)?.reply_ts, undefined)
  await appendFile(feedFile, JSON.stringify(row(later(2000), 'B1', { repo: 'r', cwd: work2, project: 'o/r', user_text: 'マージして', text: 'マージしました' })) + '\n')
  const answered = await detail()
  assert.notEqual(answered.rev, sent.rev)
  const answer = answered.agent_replies?.find((r) => r.agent_reply?.followup)
  assert.equal(answer?.text, 'マージしました')
  assert.equal(answer?.agent_reply?.message_id, line?.id)
  assert.equal(answer?.agent_reply?.handed_at, undefined)
  assert.equal(answered.agent_followups?.at(-1)?.reply_ts, answer?.ts)
  // 送り元のエージェントの会話には足さない: 次に送り元へ送る文の頭に、この返答は入らない
  runner.started.length = 0
  await humanReply('A1@r')
  assert.ok(!runner.started.at(-1)!.cmd.text.includes('マージしました'))
  idle('A1@r')

  // 送り元がメッセージを送ったことのない相手・居ない送り元の印は覚えない（返信そのものは届く）
  idle('B1@r')
  const stray = await reply('B1@r', { text: 'これは覚えない', sent_from: { id: 'ZZ@r', anchor } })
  assert.equal(stray.status, 202)
  assert.equal((await detail()).agent_followups?.some((f) => f.text === 'これは覚えない') ?? false, false)
  idle('B1@r')
  // 受け取った側の詳細には載せない
  assert.equal(((await (await fetch(`${base}/api/sessions/B1%40r`)).json()) as SessionDetailResponse).agent_followups, undefined)
})

// ---- #727: 1 ターンの回数を超えた送信を預かり、送り元のターンが終わってから順に送る

const sendMany = (from: string, items: { to: string; text: string }[]) => agent('/api/agent/send', { method: 'POST', body: JSON.stringify({ from, items }) })
const agentOf = async (id: string) => ((await (await fetch(`${base}/api/sessions/${encodeURIComponent(id)}`)).json()) as SessionDetailResponse).agent
const stopSending = (id: string, what: 'stop' | 'resume') => fetch(`${base}/api/sessions/${encodeURIComponent(id)}/agent/${what}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base }, body: '{}' })
/** 前のテストの残り（預かり・相手の預かり・連鎖の印・読み直す量）を片付けて、送り元 A1 の新しいターンを始める */
const freshTurn = async () => {
  await stopSending('A1@r', 'stop')
  await stopSending('A1@r', 'resume')
  await clearQueue('B1@r')
  contexts.clear()
  idle('B1@r')
  await humanReply('A1@r')
  idle('A1@r')
  turn('A1@r')
  runner.started.length = 0
}

test('1 ターンの回数を超えた sai_send は断らずに預かり、送り元のターンが終わってから順に送る。人が止めると残りは送られない（#727）', async () => {
  await freshTurn()
  try {
    for (const n of [1, 2, 3]) {
      const sent = (await (await send('A1@r', 'B1@r', `その場で送る ${n}`)).json()) as AgentSendResponse
      assert.equal(sent.held, undefined)
      assert.ok(sent.via)
    }
    assert.equal(runner.started.length, 3)
    // 4 件目からは 429 にせず預かる。相手のターンはまだ起こさない
    const held: AgentSendResponse[] = []
    for (const n of [4, 5, 6, 7, 8]) {
      const res = await send('A1@r', 'B1@r', `預かる ${n}`)
      assert.equal(res.status, 202)
      held.push((await res.json()) as AgentSendResponse)
    }
    assert.deepEqual(held.map((h) => [h.held, h.via, h.held_count]), [[true, undefined, 1], [true, undefined, 2], [true, undefined, 3], [true, undefined, 4], [true, undefined, 5]])
    assert.equal(new Set(held.map((h) => h.message_id)).size, 5, 'message_id は預かるときに決まる')
    assert.equal(runner.started.length, 3, '預かっただけでは相手を起こさない')
    // 依頼 1 つの上限（もう送った分 + 預かり）を超えたら断る。預かりは増えない
    const over = await send('A1@r', 'B1@r', '9 件目')
    assert.equal(over.status, 429)
    assert.match(((await over.json()) as { error: string }).error, /1 つの依頼で送れるのは 8 件まで/)
    // 人が画面で見える（古い順＝送る順）
    const shown = await agentOf('A1@r')
    assert.deepEqual(shown?.held?.map((h) => h.message_id), held.map((h) => h.message_id))
    assert.equal(shown?.held?.[0]?.halted, undefined)
    // 送り元が回っている間は、ポーリングが来ても送らない
    await poll()
    assert.equal(runner.started.length, 3)
  } finally {
    idle('A1@r')
  }
  // 送り元のターンが終わった → 1 巡ぶん（3 件）だけ、預かった順に送る。見出しの id は預かったときのもの
  await poll()
  assert.equal(runner.started.length, 6, '1 巡は 1 ターンの回数まで')
  assert.deepEqual(runner.started.slice(3).map((s) => s.id), ['B1@r', 'B1@r', 'B1@r'])
  assert.match(runner.started[3]!.cmd.text, /預かる 4$/)
  assert.match(runner.started[5]!.cmd.text, /預かる 6$/)
  assert.match(runner.started[3]!.cmd.text, /^【SAI】.*からのメッセージです（id: [0-9a-f]+）/)
  const afterRound = await agentOf('A1@r')
  assert.equal(afterRound?.held?.length, 2, '残りは次の巡まで預かったまま')
  assert.ok(afterRound?.recent.length, '送った分はいつもの記録に載る（返答は画面と次のターンの頭に届く）')
  // すぐもう一度ポーリングが来ても、巡の間が空くまでは送らない
  await poll()
  assert.equal(runner.started.length, 6)
  // 人が「送信を止める」→ 残りは捨てられ、もう送られない
  const stopped = (await (await stopSending('A1@r', 'stop')).json()) as AgentStopResponse
  assert.ok(stopped.cancelled >= 2, '預かりの残りも取り消した数に入る')
  assert.equal(stopped.agent.held, undefined)
  await poll()
  assert.equal(runner.started.length, 6)
  await stopSending('A1@r', 'resume')
  await clearQueue('B1@r')
})

test('items: 複数の宛先を 1 つの依頼として受け、合計の読み直す量が予算を超えるなら 1 件も送らずに断る。収まれば回数まで送って残りを預かる（#727）', async () => {
  await freshTurn()
  try {
    // 先に全部を数える: 250 万 × 3 = 750 万 > 600 万
    contexts.set('B1@r', 2_500_000)
    const tooBig = await sendMany('A1@r', [{ to: 'B1@r', text: '1' }, { to: 'B1@r', text: '2' }, { to: 'B1@r', text: '3' }])
    assert.equal(tooBig.status, 429)
    const why = ((await tooBig.json()) as { error: string }).error
    assert.match(why, /読み直させる量の合計が予算を超えます/)
    assert.match(why, /1 件も預かっていません/)
    assert.equal(runner.started.length, 0, '1 件も送っていない')
    assert.equal((await agentOf('A1@r'))?.held, undefined, '1 件も預かっていない')
    // 件数の上限・宛先の誤り・空の本文も、全部を確かめてから断る（途中まで送らない）
    contexts.clear()
    assert.equal((await sendMany('A1@r', Array.from({ length: 9 }, (_, n) => ({ to: 'B1@r', text: `${n}` })))).status, 429)
    assert.equal((await sendMany('A1@r', [{ to: 'B1@r', text: '送れる' }, { to: 'C1@r', text: '別のリポジトリ' }])).status, 403)
    assert.equal((await sendMany('A1@r', [{ to: 'B1@r', text: '送れる' }, { to: 'B1@r', text: '  ' }])).status, 400)
    assert.equal((await sendMany('A1@r', [])).status, 400)
    assert.equal(runner.started.length, 0)

    // 収まる依頼: 上から 3 件はその場で、残り 2 件は預かる
    contexts.set('B1@r', 100_000)
    const res = await sendMany('A1@r', [1, 2, 3, 4, 5].map((n) => ({ to: 'B1@r', text: `まとめて ${n}` })))
    assert.equal(res.status, 202)
    const body = (await res.json()) as AgentSendManyResponse
    assert.deepEqual(body.results.map((r) => Boolean(r.held)), [false, false, false, true, true])
    assert.ok(body.results.every((r) => r.message_id && r.to === 'B1@r' && r.context_tokens === 100_000))
    assert.deepEqual([body.sent, body.limit, body.held_count], [3, 3, 2])
    assert.equal(runner.started.length, 3)
    // 1 件でも預かったあとは、同じターンの次の送信も後ろに並ぶ（追い越さない）
    const later = (await (await send('A1@r', 'B1@r', 'あとから 1 件')).json()) as AgentSendResponse
    assert.deepEqual([later.held, later.held_count], [true, 3])
  } finally {
    idle('A1@r')
  }
  await stopSending('A1@r', 'stop')
  await stopSending('A1@r', 'resume')
  await clearQueue('B1@r')
  contexts.clear()
})

test('受け取ったメッセージで回っているターン・人が止めている送り元からは、預かりもしない（#727。連鎖を作らない）', async () => {
  await freshTurn()
  idle('A1@r')
  // B1 を A1 からのメッセージで起こす（B1 のターンはメッセージで回っている）
  turn('A1@r')
  try {
    assert.equal((await send('A1@r', 'B1@r', '見て')).status, 202)
  } finally {
    idle('A1@r')
  }
  turn('B1@r')
  try {
    const chained = await sendMany('B1@r', [{ to: 'A1@r', text: '返す' }])
    assert.equal(chained.status, 429)
    assert.match(((await chained.json()) as { error: string }).error, /連鎖は 1 段まで/)
    assert.equal((await agentOf('B1@r'))?.held, undefined)
  } finally {
    idle('B1@r')
  }
  await humanReply('B1@r')
  idle('B1@r')
  await stopSending('A1@r', 'stop')
  turn('A1@r')
  try {
    const res = await send('A1@r', 'B1@r', '止めている間')
    assert.equal(res.status, 429)
    assert.match(((await res.json()) as { error: string }).error, /送信を止めています/)
  } finally {
    idle('A1@r')
    await stopSending('A1@r', 'resume')
  }
  await clearQueue('B1@r')
})

test('並べて呼ばれた sai_send も 1 つずつ数える。1 件で 1 ターンの予算を超える相手は預からずに断る（#727 のレビュー）', async () => {
  await freshTurn()
  try {
    // エージェントがツールを 5 つ並べて呼んだ形。その場で送るのは 3 件まで、残りは預かる（全部が「まだ 0 回」を見ない）
    const all = await Promise.all([1, 2, 3, 4, 5].map((n) => send('A1@r', 'B1@r', `並べて ${n}`)))
    const bodies = (await Promise.all(all.map((r) => r.json()))) as AgentSendResponse[]
    assert.deepEqual(all.map((r) => r.status), [202, 202, 202, 202, 202])
    assert.equal(bodies.filter((b) => b.held).length, 2)
    assert.equal(runner.started.length, 3)
    assert.equal((await agentOf('A1@r'))?.sent, 3)
    await stopSending('A1@r', 'stop')
    await stopSending('A1@r', 'resume')
    // 1 件だけで 1 ターン（＝1 巡）の予算を超える相手は、預かっても送れないので今までどおり断る
    contexts.set('B1@r', 3_500_000)
    turn('A1@r')
    const big = await send('A1@r', 'B1@r', '大きい相手')
    assert.equal(big.status, 429)
    assert.match(((await big.json()) as { error: string }).error, /予算を超えます/)
    assert.equal((await agentOf('A1@r'))?.held, undefined)
    // 空の items は付いていないのと同じ（to / text の形として送る）
    contexts.clear()
    const res = await agent('/api/agent/send', { method: 'POST', body: JSON.stringify({ from: 'A1@r', to: 'B1@r', text: '空の items 付き', items: [] }) })
    assert.equal(res.status, 202)
    assert.equal(((await res.json()) as AgentSendResponse).to, 'B1@r')
  } finally {
    idle('A1@r')
    contexts.clear()
  }
  await clearQueue('B1@r')
})

// ---- #747: 人が許した組だけ、別のリポジトリのセッションにも送れる

const putSettings = (body: unknown, origin: string = base) =>
  fetch(`${base}/api/settings`, { method: 'PUT', headers: { 'Content-Type': 'application/json', Origin: origin }, body: JSON.stringify(body) })
const sessionsOf = async (from: string) => {
  turn(from)
  try {
    const res = await agent(`/api/agent/sessions?from=${encodeURIComponent(from)}`)
    assert.equal(res.status, 200)
    return ((await res.json()) as AgentSessionsResponse).sessions
  } finally {
    idle(from)
  }
}

test('別のリポジトリへ送る組は、同一オリジンの設定の口だけで、1 つずつ足す・外す。記録で知っているリポジトリだけ・向きつき（#747）', async () => {
  const settings = async () => (await (await fetch(`${base}/api/settings`)).json()) as SettingsResponse
  const first = await settings()
  assert.deepEqual(first.send_across, [], '既定は空（同じリポジトリの中だけ）')
  assert.ok(first.send_across_projects.includes('o/r') && first.send_across_projects.includes('o/other'), '選べるのは記録で知っているリポジトリ')
  const pair = { from: 'o/r', to: 'o/other' }
  assert.equal((await putSettings({ send_across_add: pair }, 'http://evil.example')).status, 403, '別オリジンからは変えられない')
  assert.equal((await putSettings({ send_across_add: { from: 'o/r', to: 'o/unknown' } })).status, 400, '任意の名前は持たせない')
  assert.equal((await putSettings({ send_across_add: { from: 'o/r', to: 'o/r' } })).status, 400)
  assert.equal((await putSettings({ send_across_add: 'o/other' })).status, 400)
  assert.equal((await putSettings({ send_across: [pair] })).status, 400, '丸ごと置き換える形は受けない（古い写しが、外した組を戻さないように）')
  // エージェント用の口（/api/agent/*）には、組を変える道が無い
  assert.equal((await agent('/api/agent/settings', { method: 'PUT', body: JSON.stringify({ send_across_add: pair }) })).ok, false)
  assert.deepEqual((await settings()).send_across, [], '断ったものは残らない')
  const ok = await putSettings({ send_across_add: { from: 'O/R', to: 'o/other' } })
  assert.equal(ok.status, 200)
  assert.deepEqual(((await ok.json()) as SettingsResponse).send_across, [pair], '名前は記録の書き方に揃える')
  // もう 1 回足しても増えない。外すのは 1 つずつ（無い組を外しても何も起きない）
  assert.deepEqual(((await (await putSettings({ send_across_add: pair })).json()) as SettingsResponse).send_across, [pair])
  assert.deepEqual(((await (await putSettings({ send_across_remove: { from: 'o/other', to: 'o/r' } })).json()) as SettingsResponse).send_across, [pair])
})

test('許した組では、別のリポジトリのセッションが一覧に分けて出て（呼び名・エージェント・空いているかまで）、送れる。逆向きは送れない（#747）', async () => {
  await freshTurn()
  idle('A1@r')
  const list = await sessionsOf('A1@r')
  const c = list.find((s) => s.id === 'C1@r')
  assert.deepEqual(c, { id: 'C1@r', name: '#r', project: 'o/other', branch: '', agent: 'claude', busy: false, last_text: '', context_tokens: 0, overlap: [], overlap_more: 0, across: true, holding: { free: true } }, 'ブランチ・最後の発言・同じファイル・読み直す量・PR は載せない')
  assert.equal(list.at(-1)?.id, 'C1@r', '同じリポジトリの相手が先')
  assert.equal(list.find((s) => s.id === 'B1@r')?.across, undefined)
  // 逆向き（o/other → o/r）は許していないので、見えも送れもしない
  assert.deepEqual((await sessionsOf('C1@r')).map((s) => s.id), [])
  turn('C1@r')
  try {
    assert.equal((await send('C1@r', 'A1@r', '逆向き')).status, 403)
  } finally {
    idle('C1@r')
  }
  // 送れる。見出しに送り元のリポジトリが入る（宛先が「別のリポジトリから来た」と分かる）
  runner.started.length = 0
  contexts.set('C1@r', 200_000)
  turn('A1@r')
  try {
    const res = await send('A1@r', 'C1@r', 'この形に合わせて')
    assert.equal(res.status, 202)
    const body = (await res.json()) as AgentSendResponse
    assert.deepEqual([body.to, body.to_name, body.context_tokens, body.read_tokens], ['C1@r', '#r', 0, 0], '読み直しの予算には数えるが、別のリポジトリの相手の量と題名は返さない（合計からも引く。引き算で分からないように）')
    assert.equal((await agentOf('A1@r'))?.read_tokens, 200_000, '人の画面には実際の量（予算に数えている）')
    assert.deepEqual(runner.started.map((s) => s.id), ['C1@r'])
    assert.match(runner.started[0]!.cmd.text, /^【SAI】#o\/r の「/)
    assert.equal(runner.started[0]!.cmd.cwd, work, 'cwd は宛先のセッションの行から')
    // 歯止めも同じ判定: 1 ターンの回数を超えた分は預かり、人が止めると捨てる
    assert.equal(((await (await send('A1@r', 'C1@r', '2')).json()) as AgentSendResponse).held, undefined)
    assert.equal(((await (await send('A1@r', 'C1@r', '3')).json()) as AgentSendResponse).held, undefined)
    assert.equal(((await (await send('A1@r', 'C1@r', '4 件目は預かる')).json()) as AgentSendResponse).held, true)
  } finally {
    idle('A1@r')
  }
  await stopSending('A1@r', 'stop')
  await stopSending('A1@r', 'resume')
  // 預かったあとに人が組を外したら、その先へはもう送らない（止めて画面に残す）。巡の間隔に掛からないよう、まだ預かりを送ったことのない送り元で見る
  await humanReply('B1@r')
  idle('B1@r')
  turn('B1@r')
  try {
    for (const n of [1, 2, 3]) assert.equal(((await (await send('B1@r', 'C1@r', `${n}`)).json()) as AgentSendResponse).held, undefined)
    assert.equal(((await (await send('B1@r', 'C1@r', '預かる')).json()) as AgentSendResponse).held, true)
  } finally {
    idle('B1@r')
  }
  assert.equal((await putSettings({ send_across_remove: { from: 'o/r', to: 'o/other' } })).status, 200)
  const startedBefore = runner.started.length
  await poll()
  assert.equal(runner.started.length, startedBefore, '外した先には送らない')
  assert.match((await agentOf('B1@r'))?.held?.[0]?.halted ?? '', /もう送れるセッションではありません/)
  await stopSending('B1@r', 'stop')
  await stopSending('B1@r', 'resume')
  // 外したあとは、また同じリポジトリの中だけ
  turn('A1@r')
  try {
    assert.equal((await send('A1@r', 'C1@r', 'x')).status, 403)
  } finally {
    idle('A1@r')
  }
  assert.equal((await sessionsOf('A1@r')).some((s) => s.id === 'C1@r'), false)
  contexts.clear()
  await clearQueue('C1@r')
  await humanReply('C1@r')
  idle('C1@r')
})

test('別のリポジトリの相手の返答を送り元に渡すとき、見出しに相手の題名を出さない（#747）', async () => {
  await freshTurn()
  assert.equal((await putSettings({ send_across_add: { from: 'o/r', to: 'o/other' } })).status, 200)
  await humanReply('C1@r')
  idle('C1@r')
  idle('A1@r')
  turn('A1@r')
  let messageId = ''
  let delivered = ''
  try {
    runner.started.length = 0
    messageId = ((await (await send('A1@r', 'C1@r', '形を教えて')).json()) as AgentSendResponse).message_id
    delivered = runner.started.at(-1)!.cmd.text
  } finally {
    idle('A1@r')
  }
  // 相手が返答し、そのあと相手のリポジトリの人が別の入力をした（題名がその入力になる）
  const now = Date.now()
  await appendFile(feedFile, JSON.stringify(row(new Date(now), 'C1', { repo: 'r', cwd: work, project: 'o/other', user_text: delivered, text: '形はこうです' })) + '\n')
  await appendFile(feedFile, JSON.stringify(row(new Date(now + 1000), 'C1', { repo: 'r', cwd: work, project: 'o/other', user_text: '相手のリポジトリの秘密の題名', text: '別の用事' })) + '\n')
  runner.started.length = 0
  await humanReply('A1@r')
  const handed = runner.started.at(-1)!.cmd.text
  assert.match(handed, new RegExp(`message_id: ${messageId}`))
  assert.match(handed, /形はこうです/)
  assert.match(handed, /「#r」/, '表示名が無ければ worktree 名')
  assert.doesNotMatch(handed, /秘密の題名/)
  idle('A1@r')
  // 相手のターンがあとから失敗したときの理由（reply.log の末尾＝相手の CLI の出力）も、送り元のエージェントに渡さない
  await humanReply('C1@r')
  idle('C1@r')
  turn('A1@r')
  let failedId = ''
  try {
    runner.started.length = 0
    failedId = ((await (await send('A1@r', 'C1@r', '失敗する依頼')).json()) as AgentSendResponse).message_id
    turn('C1@r', 'x', { text: runner.started.at(-1)!.cmd.text, failed: { code: 1, tail: '/秘密/の/パス が開けません' } })
    const waited = (await (await agent(`/api/agent/wait?from=A1%40r&message_id=${failedId}`)).json()) as { status: string; error?: string }
    assert.equal(waited.status, 'failed')
    assert.match(waited.error ?? '', /別のリポジトリの相手の理由は出しません/)
    assert.doesNotMatch(waited.error ?? '', /秘密/)
    // 同じターンで先に別のリポジトリへ預けた分があると、断りの文に「これまで」の量を出さない（引き算で分かる）
    contexts.set('C1@r', 2_000_000)
    contexts.set('B1@r', 2_500_000)
    assert.equal(((await (await send('A1@r', 'C1@r', '3')).json()) as AgentSendResponse).context_tokens, 0)
    const held = (await (await send('A1@r', 'C1@r', '4（預かり）')).json()) as AgentSendResponse
    assert.equal(held.held, true)
    const over = await send('A1@r', 'B1@r', '同じリポジトリへ')
    assert.equal(over.status, 429)
    const text = ((await over.json()) as { error: string }).error
    assert.match(text, /別のリポジトリの相手の量は出しません/)
    assert.doesNotMatch(text, /これまで|200 万|400 万/)
  } finally {
    idle('C1@r')
    idle('A1@r')
    contexts.clear()
  }
  await stopSending('A1@r', 'stop')
  await stopSending('A1@r', 'resume')
  assert.equal((await putSettings({ send_across_remove: { from: 'o/r', to: 'o/other' } })).status, 200)
  await clearQueue('C1@r')
  await humanReply('C1@r')
  idle('C1@r')
})

test('呼び名がリポジトリをまたいで重なるときは送らず、<リポジトリ> 付きで選び直させる（#747）', async () => {
  await freshTurn()
  idle('A1@r')
  assert.equal((await putSettings({ send_across_add: { from: 'o/r', to: 'o/other' } })).status, 200)
  const name = (id: string, value: string) => fetch(`${base}/api/sessions/${encodeURIComponent(id)}/meta`, { method: 'PUT', headers: { 'Content-Type': 'application/json', Origin: base }, body: JSON.stringify({ name: value }) })
  const nameBefore = (await (await fetch(`${base}/api/sessions/B1%40r/meta`)).json()) as { meta?: { name?: string } }
  assert.equal((await name('B1@r', '担当')).status, 200)
  assert.equal((await name('C1@r', '担当')).status, 200)
  runner.started.length = 0
  turn('A1@r')
  try {
    const res = await send('A1@r', '担当', '見て')
    assert.equal(res.status, 409)
    const text = ((await res.json()) as { error: string }).error
    assert.match(text, /「担当」に当たる相手が 2 つあります。送っていません/)
    assert.ok(text.includes('- B1@r「担当」\n- C1@r「担当」（o/other）'), text)
    assert.equal(runner.started.length, 0)
    // id なら決まる
    assert.equal(((await (await send('A1@r', 'C1@r', '見て')).json()) as AgentSendResponse).to, 'C1@r')
    // 表示名で別のリポジトリの相手に決まっても、送り元のリポジトリに同じ名前のセッションが居れば（アーカイブ済みでも）送らない
    assert.equal((await name('B1@r', '担当')).status, 200)
    const archive = (on: boolean) => fetch(`${base}/api/sessions/B1%40r/meta`, { method: 'PUT', headers: { 'Content-Type': 'application/json', Origin: base }, body: JSON.stringify({ archived_at: on ? new Date(Date.now() + 3_600_000).toISOString() : null }) })
    assert.equal((await archive(true)).status, 200)
    const startedBefore = runner.started.length
    const hidden = await send('A1@r', '担当', '見て')
    assert.equal(hidden.status, 409)
    assert.match(((await hidden.json()) as { error: string }).error, /「担当」に当たる相手が 2 つあります（うち 1 つは送れないセッション/)
    assert.equal(runner.started.length, startedBefore, '別のリポジトリへ黙って届かせない')
    assert.equal((await archive(false)).status, 200)
  } finally {
    idle('A1@r')
  }
  await name('B1@r', nameBefore.meta?.name ?? '')
  await name('C1@r', '')
  assert.equal((await putSettings({ send_across_remove: { from: 'o/r', to: 'o/other' } })).status, 200)
  await clearQueue('C1@r')
  await humanReply('C1@r')
  idle('C1@r')
})

test('組を外すと、相手の預かりに並んでいた、その向きのメッセージも取り消す（外したあとに相手で回り出さない。#747）', async () => {
  await freshTurn()
  idle('A1@r')
  await clearQueue('C1@r')
  assert.equal((await putSettings({ send_across_add: { from: 'o/r', to: 'o/other' } })).status, 200)
  turn('C1@r')
  turn('A1@r')
  try {
    const res = await send('A1@r', 'C1@r', '終わったら見て')
    assert.equal(((await res.json()) as AgentSendResponse).via, 'queued', '相手が処理中なので、相手の預かりに並ぶ')
    // 同じリポジトリの相手の預かりは触らない
    turn('B1@r')
    assert.equal(((await (await send('A1@r', 'B1@r', '同じリポジトリ')).json()) as AgentSendResponse).via, 'queued')
  } finally {
    idle('A1@r')
  }
  const queuedOf = async (id: string) => ((await (await poll()).json()) as SessionsResponse).queued[id]?.items.length ?? 0
  assert.equal(await queuedOf('C1@r'), 1)
  assert.equal((await putSettings({ send_across_remove: { from: 'o/r', to: 'o/other' } })).status, 200)
  assert.equal(await queuedOf('C1@r'), 0, '外した向きの分は取り消す')
  assert.equal(await queuedOf('B1@r'), 1, '同じリポジトリの分は残る')
  idle('C1@r')
  await clearQueue('B1@r')
  idle('B1@r')
  await humanReply('B1@r')
  idle('B1@r')
})
