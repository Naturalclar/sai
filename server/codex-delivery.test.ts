// 開いている Codex への返信の経路（#329）。本物の createApp に偽の lock 判定・queue・app-server・ProgressReader を渡して、
// - queue に渡した返信が 2 分たってもターンを始めなければ、黙って消さずに failed として一覧に出る
// - rollout が送ったあとに書かれていれば届いた扱い
// - SAI の app-server が読み込んでいるスレッドは、lock が開いていても queue に回さない
// - app-server の経路も reply.log に残る
// を見る
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import type { Server } from 'node:http'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ReplyResponse, SessionProgressResponse, SessionsResponse, SessionSummary } from '../shared/types.ts'
import { createApp } from './app.ts'
import { Approvals } from './approvals/approvals.ts'
import { localDate } from './rows/aggregate.ts'
import { row } from './rows/aggregate.test.ts'
import { FeedStore } from './rows/store.ts'
import { BuildFreshness } from './local/buildFreshness.ts'
import { Authenticator } from './auth.ts'
import { QUEUE_DELIVERY_WAIT_MS, TERMINAL_DELIVERY_WAIT_MS, TerminalReplies } from './reply/terminal.ts'
import type { Tmux } from './reply/terminal.ts'
import type { ReplyCommand, Runner } from './reply/runner.ts'
import type { CodexApp, CodexTurnInput } from './reply/codexAppServer.ts'
import type { ProgressReader } from './local/progress.ts'

let dir: string
let work: string
let server: Server
let base: string
/** TerminalReplies の時計。テストが進める */
let offset = 0
const clock = () => Date.now() + offset
const queued: ReplyCommand[] = []
const codexStarted: CodexTurnInput[] = []
/** rollout が最後に書かれた時刻（ProgressReader の updated_at）。無ければ空 */
const updatedAt = new Map<string, string>()
/** セッションごとの rollout のパス（#474。本文で届いたかを見る）。無ければ今までどおり mtime で見る */
const rollouts = new Map<string, string>()
/** SAI の app-server が読み込んでいるスレッド */
const held = new Set<string>(['H1'])

const runner: Runner = { running: () => false, snapshot: () => ({}), async start() {} }
const codexApp: CodexApp = {
  running: () => false,
  replying: () => ({}),
  snapshot: () => ({}),
  getApproval: () => undefined,
  async start(input) {
    codexStarted.push(input)
  },
  answer: () => ({ ok: false, status: 404, error: 'approval not found' }),
  holds: (threadId) => held.has(threadId),
}
const tmux: Tmux = { run: async () => '' }
const progress = {
  async read(s: SessionSummary): Promise<SessionProgressResponse> {
    return { rev: '', id: s.id, active: false, steps: [], total: 0, updated_at: updatedAt.get(s.id) ?? '', context_tokens: 0 }
  },
  async codexRollout(session: string): Promise<string> {
    return rollouts.get(session) ?? ''
  },
}
/** 届いたときに rollout に載る形（response_item の role: user） */
const userLine = (at: number, text: string) =>
  JSON.stringify({ timestamp: new Date(at).toISOString(), type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] } })

before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'sai-cdel-'))
  work = await mkdtemp(join(tmpdir(), 'sai-cdel-work-'))
  const now = new Date(Date.now() - 10 * 60_000)
  const codex = (session: string) => JSON.stringify(row(now, session, { agent: 'codex', repo: 'r', cwd: work, pane: '', pid: 0, session_source: 'rollout' }))
  await writeFile(join(dir, `${localDate(now.toISOString())}.jsonl`), ['Q1', 'Q2', 'Q3', 'Q4', 'H1', 'L1'].map(codex).join('\n') + '\n')
  // 起動時の rollout（送る前に書かれたもの）
  for (const id of ['Q1@r', 'Q2@r']) updatedAt.set(id, now.toISOString())
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
      ps: async () => '',
      replies: new TerminalReplies(clock),
      alive: () => false,
      // lock を開いているプロセスがいる（L1 だけ閉じている）
      codexWriterActive: async (session) => session !== 'L1',
      codexQueue: async (cmd) => {
        queued.push(cmd)
      },
      codexApp,
    },
    undefined,
    undefined,
    undefined,
    undefined,
    progress as unknown as ProgressReader,
  )
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

const post = (id: string, text: string) =>
  fetch(`${base}/api/sessions/${encodeURIComponent(id)}/reply?days=30`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: base },
    body: JSON.stringify({ text }),
  })
const sessions = async () => (await (await fetch(`${base}/api/sessions?days=30`)).json()) as SessionsResponse

test('queue に渡して 2 分たってもターンが始まらなければ、黙って消さずに failed として出す。次の返信は止めない', async () => {
  offset = 0
  let res = await post('Q1@r', 'SAIのmain用のアイコンも作って')
  assert.equal(res.status, 202)
  assert.equal(((await res.json()) as ReplyResponse).via, 'queue')
  assert.equal(queued.at(-1)?.text, 'SAIのmain用のアイコンも作って')
  assert.equal((await sessions()).replying['Q1@r']?.failed, undefined, '2 分たつまでは処理中のまま')

  offset = TERMINAL_DELIVERY_WAIT_MS + 1_000
  const failed = (await sessions()).replying['Q1@r']?.failed
  assert.ok(failed, '届いていないので失敗として出す')
  assert.equal(failed.code, undefined)
  assert.match(failed.tail, /届いていません/)

  res = await post('Q1@r', 'もう一度')
  assert.equal(res.status, 202, '失敗にしたら次の返信を 409 にしない')
})

test('送ったあとに rollout が書かれていれば届いた扱いで、処理中のまま', async () => {
  offset = 0
  assert.equal((await post('Q2@r', 'やって')).status, 202)
  updatedAt.set('Q2@r', new Date(clock() + 5_000).toISOString())
  offset = TERMINAL_DELIVERY_WAIT_MS + 1_000
  const replying = (await sessions()).replying['Q2@r']
  assert.equal(replying?.text, 'やって')
  assert.equal(replying?.failed, undefined)
})

test('rollout が読めるときは、送った本文が現れたかで見る。現れていれば mtime が古くても届いた扱い（#474）', async () => {
  offset = 0
  assert.equal((await post('Q3@r', '432を対応して')).status, 202)
  const path = join(work, 'rollout-Q3.jsonl')
  await writeFile(path, userLine(clock() + 500, '432を対応して') + '\n')
  rollouts.set('Q3', path)
  offset = QUEUE_DELIVERY_WAIT_MS + 1_000
  const replying = (await sessions()).replying['Q3@r']
  assert.equal(replying?.failed, undefined, '本文が載っていれば届いた')
})

test('mtime が進んでも、送った本文が rollout に現れていなければ届いていない（#474）。30 秒で分かり、reply.log にも残る', async () => {
  offset = 0
  assert.equal((await post('Q4@r', 'このリポジトリを表すアイコン画像を作成して欲しい')).status, 202)
  const path = join(work, 'rollout-Q4.jsonl')
  // 送ったあとに何かは書かれた（mtime で見ていたころは、これで「届いた」になっていた）が、人の入力は前のターンのもの
  await writeFile(path, [userLine(clock() - 60_000, '前の依頼'), JSON.stringify({ timestamp: new Date(clock() + 2_000).toISOString(), type: 'event_msg', payload: { type: 'token_count' } })].join('\n') + '\n')
  rollouts.set('Q4', path)
  updatedAt.set('Q4@r', new Date(clock() + 2_000).toISOString())
  offset = QUEUE_DELIVERY_WAIT_MS - 1_000
  assert.equal((await sessions()).replying['Q4@r']?.failed, undefined, '30 秒たつまでは処理中のまま')
  offset = QUEUE_DELIVERY_WAIT_MS + 1_000
  const failed = (await sessions()).replying['Q4@r']?.failed
  assert.ok(failed, '端末の 2 分を待たずに失敗として出す')
  assert.match(failed.tail, /開いている画面が無い/)
  const log = await readFile(join(dir, 'reply.log'), 'utf-8')
  assert.match(log, /Q4@r queue に渡した返信が届いていない: /, '画面から消えたあとも辿れる')
})

test('SAI の app-server が読み込んでいるスレッドは、lock が開いていても queue に回さない', async () => {
  offset = 0
  const before = queued.length
  const res = await post('H1@r', '続けて')
  assert.equal(res.status, 202)
  assert.equal(((await res.json()) as ReplyResponse).via, 'app-server')
  assert.equal(queued.length, before, 'queue は叩かない')
  assert.equal(codexStarted.at(-1)?.threadId, 'H1')
})

test('lock を誰も開いていない閉じた Codex は app-server で再開し、その経路も reply.log に残す', async () => {
  offset = 0
  const res = await post('L1@r', '閉じたセッションへ')
  assert.equal(((await res.json()) as ReplyResponse).via, 'app-server')
  const log = await readFile(join(dir, 'reply.log'), 'utf-8')
  assert.match(log, /L1@r Codex app-server で再開/)
})
