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
