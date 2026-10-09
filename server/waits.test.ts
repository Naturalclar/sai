// 「PR の CI が終わったら起こして」の待ち（#732）。本物の createApp を、偽の Runner・偽の gh（PrBrowser）・進められる時計で回す。
// タイマーは立てず（`loopTickMs: 0`）、待ちを見に行くのは一覧のポーリング（`GET /api/sessions`）のついでだけにする。
// 本物の ~/.agent-feed と本物の gh は触らない
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import type { Server } from 'node:http'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { PrCi } from '../shared/waits.ts'
import { WAIT_AUTO_WAKE_MS, WAIT_EMPTY_GRACE_MS, WAIT_MARK, WAIT_MAX_MS, WAIT_MAX_PER_SESSION, WAIT_POLL_MS, WAIT_READY_MAX_MS, WAIT_WAKES_PER_DAY } from '../shared/waits.ts'
import type { Replying, SessionDetailResponse, SessionsResponse, SessionSummary, SessionProgressResponse, UsageResponse, Wait, WaitActionResponse, WaitForResponse } from '../shared/types.ts'
import { createApp } from './app.ts'
import type { App } from './app.ts'
import { Approvals } from './approvals/approvals.ts'
import { Authenticator } from './auth.ts'
import { NoPrs } from './git/prs.ts'
import { BuildFreshness } from './local/buildFreshness.ts'
import type { ProgressReader } from './local/progress.ts'
import type { UsageStore } from './local/usage.ts'
import { AGENT_TOKEN_FILE } from './reply/agentMessages.ts'
import type { CodexApp } from './reply/codexAppServer.ts'
import type { ReplyCommand, Runner } from './reply/runner.ts'
import { WAIT_HALTED_ON_RESTART, WAITS_FILE } from './reply/waits.ts'
import { localDate } from './rows/aggregate.ts'
import { row } from './rows/aggregate.test.ts'
import { FeedStore } from './rows/store.ts'

let dir: string
let work: string
let server: Server
let base: string
let token: string
let app: App

/** 起動したら「処理中」にする（本物と同じ）。`finish()` で終わらせる */
class FakeRunner implements Runner {
  started: { id: string; cmd: ReplyCommand }[] = []
  busy = new Map<string, Replying>()
  private n = 0
  running(id: string) {
    const r = this.busy.get(id)
    return r !== undefined && !r.failed
  }
  snapshot() {
    return Object.fromEntries(this.busy)
  }
  async start(id: string, cmd: ReplyCommand) {
    this.started.push({ id, cmd })
    this.busy.set(id, { since: `turn-${++this.n}`, text: cmd.text })
  }
  finish(id: string, failed = false) {
    const r = this.busy.get(id)
    if (failed && r) this.busy.set(id, { ...r, failed: { code: 1, tail: 'boom' } })
    else this.busy.delete(id)
  }
  sent(id: string) {
    return this.started.filter((s) => s.id === id)
  }
}
const runner = new FakeRunner()
const codexApp: CodexApp = { running: () => false, replying: () => ({}), snapshot: () => ({}), getApproval: () => undefined, async start() {}, answer: () => ({ ok: false, status: 404, error: 'approval not found' }) }
const usage = { value: {} as UsageResponse, async get() { return this.value } }
/** セッションごとの文脈の大きさ（要約してから起こすかの判定に使う） */
const contexts = new Map<string, number>()
const progress = { async read(s: Pick<SessionSummary, 'id'>): Promise<SessionProgressResponse> { return { rev: '', id: s.id, active: false, steps: [], total: 0, updated_at: '', context_tokens: contexts.get(s.id) ?? 0 } } }

/** 偽の gh。PR 番号 → いまの CI。呼ばれた形（repo と番号）を覚える。null は「読めなかった」 */
class FakePrs {
  readonly available = true
  private readonly none = new NoPrs()
  list = () => this.none.list()
  view = () => this.none.view()
  comments = () => this.none.comments()
  lineComments = () => this.none.lineComments()
  viewer = () => this.none.viewer()
  postReview = () => this.none.postReview()
  state = new Map<number, PrCi | null>()
  calls: { repo: string; number: number }[] = []
  async ci(repo: string, number: number): Promise<PrCi | null> {
    this.calls.push({ repo, number })
    return this.state.get(number) ?? null
  }
}
const prs = new FakePrs()
const PENDING: PrCi = { state: 'OPEN', checks: 'pending', failing: [], pending: true }
const GREEN: PrCi = { state: 'OPEN', checks: 'success', failing: [], pending: false }
const RED: PrCi = { state: 'OPEN', checks: 'failure', failing: ['node (test)', 'feed (python 3.9)'], pending: false }

const realNow = new Date()
/** 待ちが見る時計。テストが進める */
let clock = realNow.getTime()
const alivePids = new Set([900])
const deps = () => ({ tmux: { run: async () => { throw new Error('unused') } }, ps: async () => '', codexApp, alive: (pid: number) => alivePids.has(pid), loopNow: () => clock, loopTickMs: 0 })
const make = (r: Runner) =>
  createApp(new FeedStore(dir), join(dir, 'dist'), r, new Approvals(), new BuildFreshness(join(dir, 'dist'), [], 0), undefined, new Authenticator(async () => null), deps(), undefined, undefined, undefined, usage as unknown as UsageStore, progress as unknown as ProgressReader, undefined, prs)

const IDS = ['W1', 'W2', 'W3', 'W4', 'W5', 'W6', 'W7', 'W8', 'W9', 'W10', 'W11', 'W12', 'W13', 'W14', 'W15']
const REMOTE = 'https://github.com/o/r'

before(async () => {
  process.env.AGENT_FEED_HOST = 'testmac'
  dir = await mkdtemp(join(tmpdir(), 'sai-wait-'))
  work = await mkdtemp(join(tmpdir(), 'sai-wait-work-'))
  const at = (n: number) => new Date(realNow.getTime() - n * 60_000)
  await writeFile(
    join(dir, `${localDate(realNow.toISOString())}.jsonl`),
    [
      ...IDS.map((s, i) => row(at(40 - i), s, { repo: 'r', cwd: work, project: 'o/r', remote: REMOTE })),
      row(at(9), 'X1', { repo: 'r', cwd: work, project: 'o/r', remote: REMOTE, agent: 'codex' }),
      row(at(8), 'T1', { repo: 'r', cwd: work, project: 'o/r', remote: REMOTE, pane: '%9', pid: 900 }),
      row(at(7), 'P1', { repo: 'r', cwd: work, project: 'o/r', remote: REMOTE }),
      // origin が GitHub でないセッション（どのリポジトリの PR か決められない）
      row(at(6), 'N1', { repo: 'r', cwd: work, project: 'r' }),
    ]
      .map((r) => JSON.stringify(r))
      .join('\n') + '\n',
  )
  app = make(runner)
  token = (await readFile(join(dir, AGENT_TOKEN_FILE), 'utf-8')).trim()
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

const post = (target: string, body: unknown = {}, headers: Record<string, string> = {}) => fetch(target, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) })
const eid = (id: string) => `${id}@r`
/** 人が返信して、SAI から回っているターンを作る（待ちを預けられるのはそのターンだけ） */
const turn = async (id: string) => {
  const res = await post(`${base}/api/sessions/${encodeURIComponent(eid(id))}/reply`, { text: 'PR を出して' })
  assert.equal(res.status, 202, await res.clone().text())
}
/** エージェントが預ける（`sai_wait_for`） */
const waitFor = (id: string, pr: unknown, then: unknown = '結果を読んで報告する', headers: Record<string, string> = {}) =>
  post(`${base}/api/agent/wait-for`, { from: eid(id), pr, then }, { 'X-SAI-Agent-Token': token, ...headers })
const errorOf = async (res: Response) => ((await res.json()) as { error: string }).error
/** 一覧のポーリング（待ちを見に行くついで）。そのセッションの待ちを返す */
const poll = async (id: string): Promise<Wait[]> => ((await (await fetch(`${base}/api/sessions`)).json()) as SessionsResponse).waits[eid(id)] ?? []
const advance = (ms: number) => (clock += ms)
const act = (id: string, wait: string, what: 'stop' | 'wake', headers: Record<string, string> = {}) => post(`${base}/api/sessions/${encodeURIComponent(eid(id))}/wait/${what}`, { wait }, headers)
/**
 * CI を「通った」「落ちた」にして、1 回目を見せる（1 回見ただけでは起こさない）。次の `poll()` が 2 回目で、そこで起きる
 */
const firstSeen = async (pr: number, ci: PrCi, at: string = base) => {
  prs.state.set(pr, ci)
  advance(WAIT_POLL_MS)
  await fetch(`${at}/api/sessions`)
  advance(WAIT_POLL_MS)
}
/** ターンを回して 1 件預け、そのターンを終わらせる */
const held = async (id: string, pr: number): Promise<Wait> => {
  prs.state.set(pr, PENDING)
  await turn(id)
  const res = await waitFor(id, pr)
  assert.equal(res.status, 200, await res.clone().text())
  runner.finish(eid(id))
  return ((await res.json()) as WaitForResponse).wait!
}

test('預かると、サーバが間隔を置いて gh で確かめる（エージェントのターンは回さない）。CI が通ったら 1 回だけ起こし、結果の要点を渡す', async () => {
  prs.calls.length = 0
  const w = await held('W1', 11)
  assert.deepEqual([w.repo, w.pr, w.status, w.then], ['o/r', 11, 'waiting', '結果を読んで報告する'])
  assert.equal(Date.parse(w.deadline) - Date.parse(w.since), WAIT_MAX_MS)
  assert.deepEqual(prs.calls, [{ repo: 'o/r', number: 11 }], 'リポジトリはセッションの行の remote から（名前は受けない）')
  const sentBefore = runner.sent(eid('W1')).length

  // 間隔が来るまでは gh を叩かない。来たら 1 回
  await poll('W1')
  await poll('W1')
  assert.equal(prs.calls.length, 1)
  advance(WAIT_POLL_MS)
  assert.equal((await poll('W1'))[0]!.status, 'waiting')
  assert.equal(prs.calls.length, 2)
  assert.equal(runner.sent(eid('W1')).length, sentBefore, '待っている間はターンを回さない')

  // 通った → 起こす。待ちは消える
  await firstSeen(11, GREEN)
  assert.deepEqual(await poll('W1'), [])
  const sent = runner.sent(eid('W1'))
  assert.equal(sent.length, sentBefore + 1)
  const text = sent.at(-1)!.cmd.text
  assert.ok(text.startsWith(`${WAIT_MARK}PR #11（o/r）: CI は全部通りました`))
  assert.match(text, /預けたときに書いたこと: 結果を読んで報告する/)
  assert.match(text, /マージはせず/)
  const args = sent.at(-1)!.cmd.args.join(' ')
  assert.ok(!args.includes('--dangerously-skip-permissions') && !args.includes('--permission-mode'), '権限のフラグは足さない')

  // 同じ待ちで 2 回は起きない
  runner.finish(eid('W1'))
  advance(WAIT_POLL_MS * 5)
  await poll('W1')
  await poll('W1')
  assert.equal(runner.sent(eid('W1')).length, sentBefore + 1)
  // 処理中の本文は短い形で出る（長い本文を一覧に載せない）
})

test('CI が落ちても 1 回起こす。落ちたチェックの名前だけを渡す', async () => {
  await held('W2', 12)
  const sentBefore = runner.sent(eid('W2')).length
  await firstSeen(12, RED)
  assert.deepEqual(await poll('W2'), [])
  const text = runner.sent(eid('W2')).at(-1)!.cmd.text
  assert.ok(text.startsWith(`${WAIT_MARK}PR #12（o/r）: CI が落ちました\n落ちたチェック: node (test) / feed (python 3.9)`))
  runner.finish(eid('W2'))
  advance(WAIT_POLL_MS * 3)
  await poll('W2')
  assert.equal(runner.sent(eid('W2')).length, sentBefore + 1, '赤でも 1 回')
})

test('預かれない形: 検査・もう終わっている・同じ PR・数の上限・読めない PR・gh の無いリポジトリ', async () => {
  await turn('W3')
  for (const bad of [0, -1, 1.5, 'abc', null]) assert.equal((await waitFor('W3', bad)).status, 400, JSON.stringify(bad))
  assert.match(await errorOf(await waitFor('W3', 21, '')), /then/)
  assert.match(await errorOf(await waitFor('W3', 21, 'あ'.repeat(301))), /300 字/)
  // 読めない PR は預からない（番号違いを黙って待たない）
  prs.state.delete(99)
  assert.match(await errorOf(await waitFor('W3', 99)), /gh で読めませんでした/)
  // もうマージ・クローズされていれば、預からずに結果を返す（起こす 1 回を使わない）
  prs.state.set(21, { state: 'CLOSED', checks: 'failure', failing: ['x'], pending: false })
  const done = (await (await waitFor('W3', 21)).json()) as WaitForResponse
  assert.deepEqual([done.wait, done.result], [undefined, 'closed'])
  assert.deepEqual(await poll('W3'), [])
  // 同じ PR は 1 つ、同時に WAIT_MAX_PER_SESSION 件まで
  for (let n = 0; n < WAIT_MAX_PER_SESSION; n++) {
    prs.state.set(30 + n, PENDING)
    assert.equal((await waitFor('W3', 30 + n)).status, 200)
  }
  assert.match(await errorOf(await waitFor('W3', 30)), /もう待っています/)
  prs.state.set(39, PENDING)
  const over = await waitFor('W3', 39)
  assert.equal(over.status, 429)
  assert.match(await errorOf(over), new RegExp(`${WAIT_MAX_PER_SESSION} 件まで`))
  runner.finish(eid('W3'))
  // origin が GitHub でないセッション
  await turn('N1')
  assert.match(await errorOf(await waitFor('N1', 5)), /GitHub のものと分からない/)
  runner.finish(eid('N1'))
})

test('預けられるのは、SAI が起こしていま回しているターンの自分のセッションだけ。ブラウザ・トークン無しは断る。端末・Claude 以外はループと同じ線で、素通し（Bypass / Auto）は預かる', async () => {
  prs.state.set(40, PENDING)
  // ターンを回していないセッション
  assert.equal((await waitFor('W4', 40)).status, 409)
  await turn('W4')
  assert.equal((await waitFor('W4', 40, 'x', { Origin: base })).status, 403, 'ブラウザからは通さない')
  assert.equal((await post(`${base}/api/agent/wait-for`, { from: eid('W4'), pr: 40, then: 'x' })).status, 403, 'トークンが要る')
  assert.equal((await fetch(`${base}/api/agent/wait-for`)).status, 405)
  runner.finish(eid('W4'))
  // 許可を聞かないモードのセッションも預かれる（#732: 1 つの待ちで起こすのは 1 回で、起きたターンから次は預けられない）
  const putMeta = (id: string, permission_mode: string) => fetch(`${base}/api/sessions/${encodeURIComponent(eid(id))}/meta`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ permission_mode }) })
  for (const [n, mode] of ['bypassPermissions', 'auto'].entries()) {
    prs.state.set(41 + n, PENDING)
    assert.equal((await putMeta('P1', mode)).status, 200)
    await turn('P1')
    const res = await waitFor('P1', 41 + n)
    assert.equal(res.status, 200, `${mode}: ${await res.clone().text()}`)
    const w = ((await res.json()) as WaitForResponse).wait!
    assert.equal(w.status, 'waiting')
    runner.finish(eid('P1'))
    assert.equal((await act('P1', w.id, 'stop')).status, 200)
  }
  assert.equal((await putMeta('P1', '')).status, 200)
  assert.deepEqual(await poll('P1'), [])
  // ループの線は変えない: 同じモードのセッションにループは組めない
  assert.equal((await putMeta('P1', 'bypassPermissions')).status, 200)
  const loop = await post(`${base}/api/sessions/${encodeURIComponent(eid('P1'))}/loop`, { goal: 'PR を片付ける', until: 'PR が 0 件', max_rounds: 2 })
  assert.match(await errorOf(loop), /許可を聞かないモード（.+）のセッションにはループを組めません/)
  assert.equal((await putMeta('P1', '')).status, 200)
})

test('素通しのセッションも、終わったら 1 回だけ起こす。SAI は権限のフラグを足さない（モードは返信と同じ道で渡る）。起きたターンからは次を預けられない', async () => {
  const putMeta = (permission_mode: string) => fetch(`${base}/api/sessions/${encodeURIComponent(eid('W5'))}/meta`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ permission_mode }) })
  assert.equal((await putMeta('bypassPermissions')).status, 200)
  await held('W5', 50)
  const sentBefore = runner.sent(eid('W5')).length
  await firstSeen(50, GREEN)
  assert.deepEqual(await poll('W5'), [])
  assert.equal(runner.sent(eid('W5')).length, sentBefore + 1)
  assert.ok(runner.sent(eid('W5')).at(-1)!.cmd.text.startsWith(`${WAIT_MARK}PR #50（o/r）: CI は全部通りました`))
  // 起きたターンから次の待ちは預けられない（素通しでも連鎖しない）
  prs.state.set(51, PENDING)
  assert.equal((await waitFor('W5', 51)).status, 409)
  runner.finish(eid('W5'))
  advance(WAIT_POLL_MS * 3)
  await poll('W5')
  assert.equal(runner.sent(eid('W5')).length, sentBefore + 1, '同じ待ちで 2 回は起きない')
  assert.equal((await putMeta('')).status, 200)
})

test('枠が残り少ないときは起こさず、画面に出る。「いま起こす」で起きる。別オリジンからは止めることも起こすこともできない', async () => {
  const w = await held('W6', 60)
  const sentBefore = runner.sent(eid('W6')).length
  usage.value = { claude: { primary: { used_percent: 85, window_minutes: 300, resets_at: Date.now() / 1000 + 3600 }, at: '' } } as unknown as UsageResponse
  try {
    await firstSeen(60, GREEN)
    const [ready] = await poll('W6')
    assert.deepEqual([ready!.status, ready!.result], ['ready', 'success'])
    assert.match(ready!.reason!, /5 時間の枠/)
    assert.match(ready!.reason!, /いま起こす/)
    advance(60_000)
    await poll('W6')
    assert.equal(runner.sent(eid('W6')).length, sentBefore, '起こしていない')
    // 詳細の応答にも載る
    const detail = (await (await fetch(`${base}/api/sessions/${encodeURIComponent(eid('W6'))}`)).json()) as SessionDetailResponse
    assert.equal(detail.waits[eid('W6')]![0]!.id, w.id)

    const cross = { Origin: 'https://evil.example' }
    assert.equal((await act('W6', w.id, 'wake', cross)).status, 403)
    assert.equal((await act('W6', w.id, 'stop', cross)).status, 403)
    assert.equal((await act('W6', 'nope', 'wake')).status, 404)
    const woke = await act('W6', w.id, 'wake')
    assert.equal(woke.status, 200)
    assert.deepEqual(((await woke.json()) as WaitActionResponse).waits, [])
    assert.equal(runner.sent(eid('W6')).length, sentBefore + 1)
    assert.ok(runner.sent(eid('W6')).at(-1)!.cmd.text.startsWith(`${WAIT_MARK}PR #60（o/r）: CI は全部通りました`))
  } finally {
    usage.value = {} as UsageResponse
    runner.finish(eid('W6'))
  }
})

test('待てる時間を過ぎた待ちは起こさず、画面に残る（人が片付ける）。チェックが載っていない PR は、猶予のあと「チェックなし」で起こす', async () => {
  const w = await held('W7', 70)
  const sentBefore = runner.sent(eid('W7')).length
  advance(WAIT_MAX_MS)
  const [expired] = await poll('W7')
  assert.equal(expired!.status, 'expired')
  assert.match(expired!.reason!, /CI が終わりませんでした/)
  prs.state.set(70, GREEN)
  advance(WAIT_POLL_MS * 2)
  await poll('W7')
  assert.equal(runner.sent(eid('W7')).length, sentBefore, '過ぎたあとに通っても起こさない')
  assert.equal((await act('W7', w.id, 'wake')).status, 409, '過ぎた待ちは起こせない（片付けるだけ）')
  assert.equal((await act('W7', w.id, 'stop')).status, 200)
  assert.deepEqual(await poll('W7'), [])

  // チェックがまだ載っていない
  prs.state.set(71, { state: 'OPEN', checks: '', failing: [], pending: false })
  await turn('W7')
  assert.equal(((await (await waitFor('W7', 71)).json()) as WaitForResponse).wait?.status, 'waiting', '出した直後の「チェックなし」は、まだ載っていないと読む')
  runner.finish(eid('W7'))
  advance(WAIT_POLL_MS)
  assert.equal((await poll('W7'))[0]!.status, 'waiting')
  advance(WAIT_EMPTY_GRACE_MS)
  assert.deepEqual(await poll('W7'), [])
  assert.ok(runner.sent(eid('W7')).at(-1)!.cmd.text.startsWith(`${WAIT_MARK}PR #71（o/r）: この PR にはチェックがありません`))
  runner.finish(eid('W7'))
})

test('処理中・預かりが残っている・前の返信が失敗しているセッションは追い越さない。gh が読めない間は待ち続ける', async () => {
  await held('W8', 80)
  const sentBefore = runner.sent(eid('W8')).length
  // gh が読めない
  prs.state.set(80, null)
  advance(WAIT_POLL_MS)
  const [unread] = await poll('W8')
  assert.equal(unread!.status, 'waiting')
  assert.match(unread!.reason!, /gh で読めませんでした/)
  // 人が別の返信を回している間に終わった
  await turn('W8')
  await firstSeen(80, GREEN)
  const [busy] = await poll('W8')
  assert.equal(busy!.status, 'ready')
  assert.match(busy!.reason!, /処理中/)
  assert.equal(runner.sent(eid('W8')).length, sentBefore + 1, '人のターンだけ')
  // そのターンが失敗した → 起こさない
  runner.finish(eid('W8'), true)
  advance(60_000)
  const [failed] = await poll('W8')
  assert.match(failed!.reason!, /前の返信が失敗/)
  assert.equal(runner.sent(eid('W8')).length, sentBefore + 1)
  // 失敗が片付いたら起きる
  runner.finish(eid('W8'))
  advance(60_000)
  assert.deepEqual(await poll('W8'), [])
  assert.equal(runner.sent(eid('W8')).length, sentBefore + 2)
  runner.finish(eid('W8'))
})

test('待ちで起きたターンからは、次の待ちも、別のセッションへの送信もできない（起きたターンが次のターンを起こさない）', async () => {
  await held('W9', 90)
  await firstSeen(90, GREEN)
  assert.deepEqual(await poll('W9'), [])
  assert.ok(runner.busy.get(eid('W9'))!.text.startsWith(WAIT_MARK))
  prs.state.set(91, PENDING)
  const again = await waitFor('W9', 91)
  assert.equal(again.status, 409)
  assert.match(await errorOf(again), /待ちで起きたターンからは、次の待ちを預けられません/)
  const send = await post(`${base}/api/agent/send`, { from: eid('W9'), to: eid('W10'), text: '見て' }, { 'X-SAI-Agent-Token': token })
  assert.equal(send.status, 429)
  assert.match(await errorOf(send), /待ちで起きたターンからは、別のセッションへ送れません/)
  assert.equal(runner.sent(eid('W10')).length, 0)
  // 一覧の処理中の本文は短い形
  const list = (await (await fetch(`${base}/api/sessions`)).json()) as SessionsResponse
  assert.equal(list.replying[eid('W9')]!.text, '待ちが終わった: PR #90')
  runner.finish(eid('W9'))
})

test('読み直す量が大きいセッションは、要約してから起こす（#579 と同じ判定）。本文は預かりの先頭に置かれる', async () => {
  await held('W10', 100)
  contexts.set(eid('W10'), 400_000)
  const sentBefore = runner.sent(eid('W10')).length
  await firstSeen(100, GREEN)
  assert.deepEqual(await poll('W10'), [])
  const sent = runner.sent(eid('W10'))
  assert.equal(sent.length, sentBefore + 1)
  assert.ok(sent.at(-1)!.cmd.text.startsWith('/compact'), '先に要約のターン')
  const list = (await (await fetch(`${base}/api/sessions`)).json()) as SessionsResponse
  assert.ok(list.queued[eid('W10')]!.items[0]!.text.startsWith(WAIT_MARK), '本文は預かりの先頭')
  contexts.delete(eid('W10'))
})

test('自動で起こすのは 24 時間に決めた回数まで。超えたら起こさず画面に出す', async () => {
  for (let n = 0; n < WAIT_WAKES_PER_DAY; n++) {
    await held('W11', 200 + n)
    await firstSeen(200 + n, GREEN)
    assert.deepEqual(await poll('W11'), [], `${n + 1} 回目`)
    runner.finish(eid('W11'))
  }
  const sentBefore = runner.sent(eid('W11')).length
  await held('W11', 299)
  await firstSeen(299, GREEN)
  const [capped] = await poll('W11')
  assert.equal(capped!.status, 'ready')
  assert.match(capped!.reason!, new RegExp(`24 時間に ${WAIT_WAKES_PER_DAY} 回まで`))
  assert.equal(runner.sent(eid('W11')).length, sentBefore + 1, '預けるための人のターンだけ')
})

test('サーバを立て直しても待ちが残る。起こしている途中で立て直されたものは、送り直さずに止める', async () => {
  const w = await held('W12', 300)
  const file = JSON.parse(await readFile(join(dir, WAITS_FILE), 'utf-8')) as { waits: Record<string, Wait[]> }
  assert.equal(file.waits[eid('W12')]![0]!.id, w.id)
  // 起こしている途中の印を付けたまま、別のサーバを立てる
  file.waits[eid('W12')] = [...file.waits[eid('W12')]!, { ...w, id: 'feedfacefeedface', pr: 301, status: 'waking', result: 'success' }]
  await writeFile(join(dir, WAITS_FILE), JSON.stringify(file))
  const second = new FakeRunner()
  const app2 = make(second)
  const server2 = createServer((req, res) => void app2(req, res))
  await new Promise<void>((resolve) => server2.listen(0, '127.0.0.1', resolve))
  const addr = server2.address()
  const base2 = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`
  try {
    await firstSeen(300, GREEN, base2)
    const list = ((await (await fetch(`${base2}/api/sessions`)).json()) as SessionsResponse).waits[eid('W12')] ?? []
    // 残っていた待ちは、立て直したサーバが確かめて起こす
    assert.deepEqual(second.sent(eid('W12')).map((s) => s.cmd.text.split('\n')[0]), [`${WAIT_MARK}PR #300（o/r）: CI は全部通りました`])
    // 起こしている途中だったものは送り直さない
    assert.deepEqual(list.map((x) => [x.pr, x.status, x.reason]), [[301, 'halted', WAIT_HALTED_ON_RESTART]])
  } finally {
    app2.dispose()
    await new Promise<void>((resolve) => server2.close(() => resolve()))
  }
})

test('「全部通った」は 1 回見ただけでは信じない: 次も通っていたら起こす。途中で「まだ」に戻れば数え直す。預けるときに通っていても、その場では返さず預かる', async () => {
  // 預けるときにもう「通った」（push の直後に、速いチェックだけが載っている場面）
  prs.state.set(400, GREEN)
  await turn('W1')
  const res = (await (await waitFor('W1', 400)).json()) as WaitForResponse
  assert.deepEqual([res.result, res.wait?.status], [undefined, 'waiting'], '預かる（その場で「通った」と返さない）')
  runner.finish(eid('W1'))
  const sentBefore = runner.sent(eid('W1')).length
  // 遅いチェックが載って「まだ」に戻った → 起こさない
  prs.state.set(400, PENDING)
  advance(WAIT_POLL_MS)
  assert.equal((await poll('W1'))[0]!.status, 'waiting')
  // 通った（1 回目）→ まだ起こさない
  prs.state.set(400, GREEN)
  advance(WAIT_POLL_MS)
  assert.equal((await poll('W1'))[0]!.status, 'waiting')
  assert.equal(runner.sent(eid('W1')).length, sentBefore)
  // 2 回目も通っている → 起こす
  advance(WAIT_POLL_MS)
  assert.deepEqual(await poll('W1'), [])
  assert.equal(runner.sent(eid('W1')).length, sentBefore + 1)
  runner.finish(eid('W1'))
  // マージ済み・クローズは、あとから変わらないので 1 回で終わり（預けるときはその場で返す）
  prs.state.set(401, { state: 'MERGED', checks: 'pending', failing: [], pending: true })
  await turn('W1')
  assert.equal(((await (await waitFor('W1', 401)).json()) as WaitForResponse).result, 'merged')
  runner.finish(eid('W1'))
})

test('待てる時間を過ぎていても、最後に 1 回は読む（サーバが止まっていた間に終わっていれば、結果を出す。待ち始めてから長いので自動では起こさない）。終わったのに起こせないまま長く経った待ちは、見に行くのをやめる', async () => {
  const late = await held('W2', 410)
  const sentBefore = runner.sent(eid('W2')).length
  prs.state.set(410, RED)
  advance(WAIT_MAX_MS + 60_000)
  const [shown] = await poll('W2')
  assert.deepEqual([shown!.status, shown!.result, shown!.late], ['ready', 'failure', true], '時間切れの前に終わっていたので、諦めずに結果を出す')
  assert.equal(runner.sent(eid('W2')).length, sentBefore)
  assert.equal((await act('W2', late.id, 'wake')).status, 200)
  assert.equal(runner.sent(eid('W2')).length, sentBefore + 1)
  assert.ok(runner.sent(eid('W2')).at(-1)!.cmd.text.includes('CI が落ちました'))
  runner.finish(eid('W2'))
  // 前の返信が失敗したまま、次の待ちが終わる → 起こせない。長く経ったら halted にして枠を空ける
  await held('W2', 411)
  await turn('W2')
  runner.finish(eid('W2'), true)
  await firstSeen(411, RED)
  const [stuck] = await poll('W2')
  assert.equal(stuck!.status, 'ready')
  assert.match(stuck!.reason!, /前の返信が失敗/)
  advance(WAIT_READY_MAX_MS)
  const [given] = await poll('W2')
  assert.equal(given!.status, 'halted')
  assert.match(given!.reason!, /起こせませんでした（前の返信が失敗/)
  // halted は同時の数に数えない
  runner.finish(eid('W2'))
  await held('W2', 412)
  await held('W2', 413)
})

test('人の「いま起こす」で起こせなかったときは、理由を返すだけで待ちには書かない', async () => {
  const w = await held('W4', 420)
  await turn('W4')
  const res = await act('W4', w.id, 'wake')
  assert.equal(res.status, 409)
  assert.match(await errorOf(res), /処理中/)
  assert.equal((await poll('W4'))[0]!.reason, undefined, '「終わったら起こします」を待っている途中の待ちに書かない')
  runner.finish(eid('W4'))
  assert.equal((await act('W4', w.id, 'stop')).status, 200)
})

test('「落ちた」も 1 回では信じない（回し直しの直後に前の結果が残っている）。1 つ落ちていても、走っているチェックがあるうちは起こさない', async () => {
  // 預けるときに前の回の「落ちた」が残っている → その場で「落ちた」と返さず預かる
  prs.state.set(500, RED)
  await turn('W5')
  const res = (await (await waitFor('W5', 500)).json()) as WaitForResponse
  assert.deepEqual([res.result, res.wait?.status], [undefined, 'waiting'])
  runner.finish(eid('W5'))
  const sentBefore = runner.sent(eid('W5')).length
  // 回し直しが始まった（1 つは落ちたまま、もう 1 つが走っている）→ まだ
  prs.state.set(500, { state: 'OPEN', checks: 'failure', failing: ['lint'], pending: true })
  advance(WAIT_POLL_MS)
  assert.equal((await poll('W5'))[0]!.status, 'waiting')
  advance(WAIT_POLL_MS)
  assert.equal((await poll('W5'))[0]!.status, 'waiting', '走っているチェックがあるうちは、何回見ても起こさない')
  assert.equal(runner.sent(eid('W5')).length, sentBefore)
  // 全部終わって、落ちたのは 2 つ → 2 回見てから 1 回だけ起こし、名前を全部渡す
  await firstSeen(500, RED)
  assert.deepEqual(await poll('W5'), [])
  assert.ok(runner.sent(eid('W5')).at(-1)!.cmd.text.includes('落ちたチェック: node (test) / feed (python 3.9)'))
  runner.finish(eid('W5'))
})

test('確かめるだけの書き込みでは rev を進めない（毎分の確かめで画面を描き直させない）', async () => {
  await held('W6', 510)
  const rev = async () => ((await (await fetch(`${base}/api/sessions`)).json()) as SessionsResponse).rev
  const before1 = await rev()
  const calls = prs.calls.length
  advance(WAIT_POLL_MS)
  const after1 = await rev()
  assert.ok(prs.calls.slice(calls).some((c) => c.number === 510), 'gh は読んだ')
  assert.equal(after1, before1, '画面に出る形が変わっていないので rev は同じ')
  const [w] = await poll('W6')
  assert.equal((await act('W6', w!.id, 'stop')).status, 200)
})


test('待ち始めてから決めた時間のうちに終わった待ちは自動で 1 回起こす。過ぎて終わった待ちは起こさず、結果を出して人の「いま起こす」を待つ', async () => {
  // ぎりぎり間に合った: 2 回目に見たときが線の上
  await held('W13', 600)
  let sentBefore = runner.sent(eid('W13')).length
  advance(WAIT_AUTO_WAKE_MS - WAIT_POLL_MS * 2)
  await firstSeen(600, GREEN)
  assert.deepEqual(await poll('W13'), [])
  assert.equal(runner.sent(eid('W13')).length, sentBefore + 1, '線のうちなら今までどおり起こす')
  runner.finish(eid('W13'))

  // 線を過ぎて終わった: 起こさない。何度見に行っても起こさない
  const w = await held('W13', 601)
  sentBefore = runner.sent(eid('W13')).length
  advance(WAIT_AUTO_WAKE_MS - WAIT_POLL_MS)
  await firstSeen(601, RED)
  const [shown] = await poll('W13')
  assert.deepEqual([shown!.status, shown!.result, shown!.late], ['ready', 'failure', true])
  assert.match(shown!.reason!, new RegExp(`${WAIT_AUTO_WAKE_MS / 60_000} 分を過ぎて終わったので、自動では起こしません`))
  for (let n = 0; n < 3; n++) {
    advance(WAIT_POLL_MS * 10)
    assert.equal((await poll('W13'))[0]!.late, true)
  }
  assert.equal(runner.sent(eid('W13')).length, sentBefore, '自動では起こさない')
  // 立て直しても、自動では起こさないまま
  const again = make(runner)
  const s2 = createServer((req, res) => void again(req, res))
  await new Promise<void>((resolve) => s2.listen(0, '127.0.0.1', resolve))
  try {
    const a2 = s2.address()
    const at = `http://127.0.0.1:${typeof a2 === 'object' && a2 ? a2.port : 0}`
    advance(WAIT_POLL_MS)
    const kept = ((await (await fetch(`${at}/api/sessions`)).json()) as SessionsResponse).waits[eid('W13')] ?? []
    assert.deepEqual([kept[0]?.status, kept[0]?.late], ['ready', true])
    assert.equal(runner.sent(eid('W13')).length, sentBefore)
  } finally {
    again.dispose()
    await new Promise<void>((resolve) => s2.close(() => resolve()))
  }
  // 人の「いま起こす」で起きる。結果と落ちたチェックの名前はそのまま渡る。待ちは消える（1 回だけ）
  assert.equal((await act('W13', w.id, 'wake')).status, 200)
  assert.deepEqual(await poll('W13'), [])
  assert.equal(runner.sent(eid('W13')).length, sentBefore + 1)
  const woke = runner.sent(eid('W13')).at(-1)!.cmd.text
  assert.ok(woke.startsWith(`${WAIT_MARK}PR #601（o/r）: CI が落ちました\n落ちたチェック: node (test)`))
  assert.match(woke, /終わったときに確かめたものです/, '時間が空いているので、いまの状態を確かめさせる')
  runner.finish(eid('W13'))
  // 起こしたあとは、もう自動でも起きない（1 つの待ちで 1 回）
  advance(WAIT_POLL_MS * 5)
  await poll('W13')
  assert.equal(runner.sent(eid('W13')).length, sentBefore + 1)

  // 自動では起こさないまま残っている待ちがあっても、同じ PR に預け直せる（古いほうは置き換わる。枠も使わない）
  const stale = await held('W13', 602)
  advance(WAIT_AUTO_WAKE_MS)
  await firstSeen(602, RED)
  assert.equal((await poll('W13'))[0]!.late, true)
  const redone = await held('W13', 602)
  const left = await poll('W13')
  assert.deepEqual(left.map((x) => [x.id, x.status, x.late]), [[redone.id, 'waiting', undefined]])
  assert.notEqual(redone.id, stale.id)
  assert.equal((await act('W13', redone.id, 'stop')).status, 200)
})

test('自動では起こさない待ちも、読み直す量が大きければ要約してから起こす。押されないまま長く経ったら見に行くのをやめる', async () => {
  const w = await held('W14', 610)
  advance(WAIT_AUTO_WAKE_MS)
  await firstSeen(610, GREEN)
  assert.equal((await poll('W14'))[0]!.late, true)
  contexts.set(eid('W14'), 500_000)
  try {
    assert.equal((await act('W14', w.id, 'wake')).status, 200)
    assert.ok(runner.sent(eid('W14')).at(-1)!.cmd.text.startsWith('/compact'), '先に要約を回す')
  } finally {
    contexts.delete(eid('W14'))
    runner.finish(eid('W14'))
  }
  await poll('W14')
  runner.finish(eid('W14'))

  const idle = await held('W15', 611)
  advance(WAIT_AUTO_WAKE_MS)
  await firstSeen(611, GREEN)
  assert.equal((await poll('W15'))[0]!.late, true)
  advance(WAIT_READY_MAX_MS)
  const [given] = await poll('W15')
  assert.equal(given!.status, 'halted')
  assert.match(given!.reason!, /起こされませんでした/)
  assert.equal((await act('W15', idle.id, 'stop')).status, 200)
})
