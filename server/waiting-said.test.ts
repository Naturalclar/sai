// 「待ちます」と言って終わったのに、待ちが預けられていないセッションの印と、人が待ちを置く口（#732 の案 3）。
// 本物の createApp を、偽の Runner・偽の gh（PrBrowser）で回す。行は全部作り物で、本物の ~/.agent-feed と本物の gh は触らない
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import type { Server } from 'node:http'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { PrCi } from '../shared/waits.ts'
import { WAIT_HUMAN_THEN, WAITING_SAID_FRESH_MS } from '../shared/waitingSaid.ts'
import type { PrSummary, SessionProgressResponse, SessionsResponse, SessionSummary, UsageResponse, WaitActionResponse } from '../shared/types.ts'
import { createApp } from './app.ts'
import type { App } from './app.ts'
import { Approvals } from './approvals/approvals.ts'
import { Authenticator } from './auth.ts'
import { NoPrs } from './git/prs.ts'
import { BuildFreshness } from './local/buildFreshness.ts'
import type { ProgressReader } from './local/progress.ts'
import type { UsageStore } from './local/usage.ts'
import type { CodexApp } from './reply/codexAppServer.ts'
import type { Runner } from './reply/runner.ts'
import { localDate } from './rows/aggregate.ts'
import { row } from './rows/aggregate.test.ts'
import { FeedStore } from './rows/store.ts'

let dir: string
let work: string
let server: Server
let base: string
let app: App

const runner: Runner = { running: () => false, snapshot: () => ({}), start: async () => {} }
const codexApp: CodexApp = { running: () => false, replying: () => ({}), snapshot: () => ({}), getApproval: () => undefined, async start() {}, answer: () => ({ ok: false, status: 404, error: 'approval not found' }) }
const usage = { value: {} as UsageResponse, async get() { return this.value } }
// transcript は無い（補う返答も無い）
const progress = { async read(s: Pick<SessionSummary, 'id'>): Promise<SessionProgressResponse> { return { rev: '', id: s.id, active: false, steps: [], total: 0, updated_at: '', context_tokens: 0 } }, claudeSig: async () => '', claudeTurns: async () => null }

const pr = (number: number, head: string): PrSummary => ({ number, title: `PR ${number}`, author: 'someone', head, base: 'main', draft: false, updated_at: '', url: '', additions: 0, deletions: 0, changed_files: 0 }) as PrSummary
const PENDING: PrCi = { state: 'OPEN', checks: 'pending', failing: [], pending: true }

/** 偽の gh。open な PR の一覧と、PR ごとの CI。`cached()` は、テストが `loaded` を立てるまで「まだ無い」（裏で読みに行ったことだけ覚える） */
class FakePrs {
  readonly available = true
  private readonly none = new NoPrs()
  view = () => this.none.view()
  comments = () => this.none.comments()
  lineComments = () => this.none.lineComments()
  viewer = () => this.none.viewer()
  postReview = () => this.none.postReview()
  open: PrSummary[] = [pr(51, 'feat-a'), pr(55, 'feat-e'), pr(57, 'feat-g'), pr(58, 'feat-g'), pr(59, 'feat-h'), pr(60, 'feat-old'), pr(61, 'feat-i'), { ...pr(62, 'feat-fork'), cross: true }, { ...pr(63, 'main'), base: 'main' }]
  checks = new Map<number, PrCi | null>([[51, PENDING], [55, PENDING], [59, { state: 'MERGED', checks: 'success', failing: [], pending: false }]])
  loaded = false
  /** 待たずに裏で読みに行かせたリポジトリ */
  asked: string[] = []
  /** 待って読み直した回数（置くとき） */
  fresh = 0
  async list(_repo: string, fresh = false): Promise<PrSummary[] | null> {
    if (fresh) this.fresh++
    return this.open
  }
  cached(repo: string): PrSummary[] | undefined {
    if (this.loaded) return this.open
    this.asked.push(repo)
    return undefined
  }
  async ci(_repo: string, number: number): Promise<PrCi | null> {
    return this.checks.get(number) ?? null
  }
}
const prs = new FakePrs()
const REMOTE = 'https://github.com/o/r'
const now = new Date()
const WAITING = 'PR を出しました。\n\nCI の結果を待ちます。'

before(async () => {
  process.env.AGENT_FEED_HOST = 'testmac'
  dir = await mkdtemp(join(tmpdir(), 'sai-waiting-said-'))
  work = await mkdtemp(join(tmpdir(), 'sai-waiting-said-work-'))
  const at = (min: number) => new Date(now.getTime() - min * 60_000)
  const s = (id: string, min: number, over: Record<string, unknown>) => row(at(min), id, { repo: 'r', cwd: work, project: 'o/r', remote: REMOTE, ...over })
  await writeFile(
    join(dir, `${localDate(now.toISOString())}.jsonl`),
    [
      // 印が出る: 末尾が「待ちます」・最後の行がそのターン完了・ブランチの PR が 1 つ
      s('A', 30, { branch: 'feat-a', text: WAITING }),
      // 人が次に何か打った
      s('B', 30, { branch: 'feat-a', text: WAITING }),
      s('B', 20, { branch: 'feat-a', event: 'UserPromptSubmit', text: '', user_text: '結果は？' }),
      // ブランチから出ている PR が無い
      s('C', 30, { branch: 'feat-c', text: WAITING }),
      // 人を待っている
      s('D', 30, { branch: 'feat-a', text: 'PR を出しました。マージは「マージして」を待ちます。' }),
      // 許可を聞かないモードにする（#732: それでも置ける）
      s('E', 30, { branch: 'feat-e', text: WAITING }),
      // 送信を止めたセッション（置けない。印は出る）
      s('S', 30, { branch: 'feat-e', text: WAITING }),
      // 古い
      s('F', Math.round(WAITING_SAID_FRESH_MS / 60_000) + 30, { branch: 'feat-old', text: WAITING }),
      // 同じブランチから PR が 2 つ
      s('G', 30, { branch: 'feat-g', text: WAITING }),
      // もうマージされている PR
      s('H', 30, { branch: 'feat-h', text: WAITING }),
      // 端末で開いたセッション: ターンの 60 秒あとに「入力待ち」の行が来る（そのあとも印は残す）
      s('I', 30, { branch: 'feat-i', text: WAITING }),
      s('I', 29, { branch: 'feat-i', event: 'Notification', text: '入力待ち', user_text: '' }),
      // 同じ名前のブランチから出た fork の PR・既定のブランチにいるセッション（結ばない）
      s('J', 30, { branch: 'feat-fork', text: WAITING }),
      s('K', 30, { branch: 'main', text: WAITING }),
      // Claude 以外
      s('X', 30, { branch: 'feat-a', text: WAITING, agent: 'codex' }),
    ]
      .map((r) => JSON.stringify(r))
      .join('\n') + '\n',
  )
  app = createApp(new FeedStore(dir), join(dir, 'dist'), runner, new Approvals(), new BuildFreshness(join(dir, 'dist'), [], 0), undefined, new Authenticator(async () => null), { tmux: { run: async () => { throw new Error('unused') } }, ps: async () => '', codexApp, loopTickMs: 0 }, undefined, undefined, undefined, usage as unknown as UsageStore, progress as unknown as ProgressReader, undefined, prs)
  server = createServer((req, res) => void app(req, res))
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const addr = server.address()
  base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`
})

after(async () => {
  app.dispose()
  await new Promise<void>((resolve) => server.close(() => resolve()))
  await rm(dir, { recursive: true, force: true })
  await rm(work, { recursive: true, force: true })
})

const eid = (id: string) => `${id}@r`
const list = async () => (await (await fetch(`${base}/api/sessions?days=3`)).json()) as SessionsResponse
const marks = (r: SessionsResponse) => Object.fromEntries(r.sessions.filter((s) => s.wait_unset).map((s) => [s.id, s.wait_unset]))
const add = (id: string, body: unknown = {}, origin = base) => fetch(`${base}/api/sessions/${encodeURIComponent(eid(id))}/wait/add`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin }, body: JSON.stringify(body) })
const errorOf = async (res: Response) => ((await res.json()) as { error: string }).error

test('印: 末尾が「待ちます」で待ちが無く、ブランチの PR が 1 つに決まるセッションにだけ出す。PR の一覧は待たずに裏で読み、読めてから出す', async () => {
  const first = await list()
  assert.deepEqual(marks(first), {}, 'PR の一覧をまだ読めていない間は出さない（分からないときは出さない）')
  assert.ok(prs.asked.length > 0 && prs.asked.every((repo) => repo === 'o/r') && prs.fresh === 0, '一覧のポーリングでは gh を待たない（裏で読みに行くだけ）')
  assert.equal(prs.asked.length, 9, '読みに行くのは、ほかの条件が全部そろったセッションの分だけ（人が次に打った・人待ち・古い・Claude 以外の分は読まない）')
  prs.loaded = true
  const second = await list()
  assert.deepEqual(Object.keys(marks(second)).sort(), [eid('A'), eid('E'), eid('H'), eid('I'), eid('S')], '人が次に打った・PR が無い・人を待っている・古い・PR が 2 つ・fork の PR・既定のブランチ・Claude 以外は出さない')
  assert.deepEqual(marks(second)[eid('I')], { pr: 61 }, '「入力待ち」の行が後ろに来ても出す（端末で開いたセッション）')
  assert.deepEqual(marks(second)[eid('A')], { pr: 51 })
  assert.notEqual(first.rev, second.rev, '出たら画面が描き直る')
  assert.equal((await list()).rev, second.rev, '変わらなければ rev も同じ')
})

test('置く: PR はセッションのブランチから機械で引く（番号は受けない）。同じ置き場・同じ上限。置いたら印は消える。別オリジンは断る', async () => {
  assert.equal((await add('A', {}, 'http://evil.example')).status, 403)
  assert.equal((await fetch(`${base}/api/sessions/${encodeURIComponent(eid('A'))}/wait/add`)).status, 405)
  const res = await add('A', { pr: 999, then: '何でもやる' })
  assert.equal(res.status, 200, await res.clone().text())
  const body = (await res.json()) as WaitActionResponse
  assert.deepEqual(body.waits.map((w) => [w.repo, w.pr, w.then, w.status]), [['o/r', 51, WAIT_HUMAN_THEN, 'waiting']], 'リクエストの番号・やることは使わない')
  assert.equal(prs.fresh, 1, '置くときは PR の一覧を読み直す')
  const later = await list()
  assert.equal(marks(later)[eid('A')], undefined, '待ちが置かれたら印は出さない')
  assert.equal(later.waits[eid('A')]?.length, 1)
  const again = await add('A')
  assert.equal(again.status, 429)
  assert.match(await errorOf(again), /PR #51 の CI はもう待っています/)
  // 止めたあとに、同じターンの印を出し直さない（人がいま要らないと決めた）
  const stop = await fetch(`${base}/api/sessions/${encodeURIComponent(eid('A'))}/wait/stop`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base }, body: JSON.stringify({ wait: body.waits[0]!.id }) })
  assert.equal(stop.status, 200)
  const stopped = await list()
  assert.equal(stopped.waits[eid('A')], undefined)
  assert.equal(marks(stopped)[eid('A')], undefined)
})

test('許可を聞かないモード（Bypass / Auto）のセッションにも置ける（#732: 待ちは 1 回しか起こさない）。置けないとき: 送信を止めたセッションは印だけ出て、口は理由つきで断る。PR が無い・2 つ・もうマージ済みも置かない', async () => {
  const put = (id: string, permission_mode: string) => fetch(`${base}/api/sessions/${encodeURIComponent(eid(id))}/meta`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ permission_mode }) })
  for (const mode of ['bypassPermissions', 'auto']) {
    assert.equal((await put('E', mode)).status, 200)
    assert.deepEqual(marks(await list())[eid('E')], { pr: 55 }, `${mode}: 断りの理由は付かない`)
  }
  const placed = await add('E')
  assert.equal(placed.status, 200, await placed.clone().text())
  const [w] = (await list()).waits[eid('E')] ?? []
  assert.deepEqual([w?.pr, w?.status], [55, 'waiting'])
  assert.equal((await fetch(`${base}/api/sessions/${encodeURIComponent(eid('E'))}/wait/stop`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base }, body: JSON.stringify({ wait: w!.id }) })).status, 200)
  assert.equal((await put('E', '')).status, 200)

  const agentAct = (what: 'stop' | 'resume') => fetch(`${base}/api/sessions/${encodeURIComponent(eid('S'))}/agent/${what}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base }, body: '{}' })
  assert.equal((await agentAct('stop')).status, 200)
  const blocked = marks(await list())[eid('S')]
  assert.equal(blocked?.pr, 55)
  assert.match(blocked?.blocked ?? '', /送信を止めているので、待ちも置けません/)
  const res = await add('S')
  assert.equal(res.status, 409)
  assert.match(await errorOf(res), /送信を止めている/)
  assert.equal((await list()).waits[eid('S')], undefined)
  assert.equal((await agentAct('resume')).status, 200)
  assert.deepEqual(marks(await list())[eid('S')], { pr: 55 }, '戻せば置ける')

  const none = await add('C')
  assert.equal(none.status, 400)
  assert.match(await errorOf(none), /open な PR がありません/)
  const two = await add('G')
  assert.equal(two.status, 400)
  assert.match(await errorOf(two), /PR が 2 件あり/)
  const merged = await add('H')
  assert.equal(merged.status, 409)
  assert.match(await errorOf(merged), /PR #59 はもうマージされています/)
  assert.equal((await add('nope')).status, 404)
  const fork = await add('J')
  assert.equal(fork.status, 400)
  assert.match(await errorOf(fork), /open な PR がありません/, 'fork の PR は結ばない')
})

test('ループが組まれているセッションには印を出さず、待ちも置かせない（次の周で起きる）', async () => {
  assert.deepEqual(marks(await list())[eid('I')], { pr: 61 })
  const loop = await fetch(`${base}/api/sessions/${encodeURIComponent(eid('I'))}/loop`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base }, body: JSON.stringify({ goal: 'CI を見る', until: '緑になったら' }) })
  assert.equal(loop.status, 200, await loop.clone().text())
  assert.equal(marks(await list())[eid('I')], undefined)
  const res = await add('I')
  assert.equal(res.status, 409)
  assert.match(await errorOf(res), /ループが組まれている/)
})
