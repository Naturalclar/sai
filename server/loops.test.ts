// セッションに組むループ（#634）。本物の createApp を、偽の Runner と進められる時計で回す。
// タイマーは立てず（`loopTickMs: 0`）、周を見に行くのは一覧のポーリング（`GET /api/sessions`）のついでだけにする
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import type { Server } from 'node:http'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LOOP_MARK, LOOP_MAX_INTERVAL_S, LOOP_MIN_INTERVAL_S, LOOP_STALL_ROUNDS, loopPromptLabel } from '../shared/loops.ts'
import type { Loop, LoopNextResponse, LoopResponse, Replying, SessionDetailResponse, SessionsResponse, SessionSummary, SessionProgressResponse, UsageResponse } from '../shared/types.ts'
import { createApp } from './app.ts'
import type { App } from './app.ts'
import { Approvals } from './approvals/approvals.ts'
import { Authenticator } from './auth.ts'
import { BuildFreshness } from './local/buildFreshness.ts'
import type { ProgressReader } from './local/progress.ts'
import type { UsageStore } from './local/usage.ts'
import { AGENT_TOKEN_FILE } from './reply/agentMessages.ts'
import type { CodexApp } from './reply/codexAppServer.ts'
import { LOOPS_FILE } from './reply/loops.ts'
import type { ReplyCommand, Runner } from './reply/runner.ts'
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
/** `hook` は使用量を読んでいる最中（周を起こす直前の await）に挟む操作 */
const usage = { value: {} as UsageResponse, hook: null as null | (() => Promise<void>), async get() { const h = this.hook; this.hook = null; if (h) await h(); return this.value } }
const progress = { async read(s: Pick<SessionSummary, 'id'>): Promise<SessionProgressResponse> { return { rev: '', id: s.id, active: false, steps: [], total: 0, updated_at: '', context_tokens: 0 } } }
const realNow = new Date()
/** ループが見る時計。テストが進める */
let clock = realNow.getTime()
const alivePids = new Set([900])
const deps = () => ({ tmux: { run: async () => { throw new Error('unused') } }, ps: async () => '', codexApp, alive: (pid: number) => alivePids.has(pid), loopNow: () => clock, loopTickMs: 0 })
const make = (r: Runner) =>
  createApp(new FeedStore(dir), join(dir, 'dist'), r, new Approvals(), new BuildFreshness(join(dir, 'dist'), [], 0), undefined, new Authenticator(async () => null), deps(), undefined, undefined, undefined, usage as unknown as UsageStore, progress as unknown as ProgressReader)

const IDS = ['L1', 'L2', 'L3', 'L4', 'L5', 'L6', 'L7', 'L8', 'L9']

before(async () => {
  process.env.AGENT_FEED_HOST = 'testmac'
  dir = await mkdtemp(join(tmpdir(), 'sai-loop-'))
  work = await mkdtemp(join(tmpdir(), 'sai-loop-work-'))
  const at = (n: number) => new Date(realNow.getTime() - n * 60_000)
  await writeFile(
    join(dir, `${localDate(realNow.toISOString())}.jsonl`),
    [
      ...IDS.map((s, i) => row(at(30 - i), s, { repo: 'r', cwd: work, project: 'o/r' })),
      row(at(9), 'X1', { repo: 'r', cwd: work, project: 'o/r', agent: 'codex' }),
      row(at(8), 'T1', { repo: 'r', cwd: work, project: 'o/r', pane: '%9', pid: 900 }),
      row(at(7), 'P1', { repo: 'r', cwd: work, project: 'o/r' }),
      row(at(6), 'R1', { repo: 'r', cwd: work, project: 'o/r', host: 'mini' }),
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

const url = (id: string, rest = '') => `${base}/api/sessions/${encodeURIComponent(`${id}@r`)}/loop${rest}`
const post = (target: string, body: unknown = {}, headers: Record<string, string> = {}) => fetch(target, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) })
const GOAL = { goal: 'open な PR を片付ける', until: 'open な PR が 0 件' }
const start = async (id: string, over: object = {}) => {
  const res = await post(url(id), { ...GOAL, ...over })
  assert.equal(res.status, 200, await res.clone().text())
  return ((await res.json()) as LoopResponse).loop!
}
/** 一覧のポーリング（ループを見に行くついで）。そのセッションのループを返す */
const poll = async (id: string): Promise<Loop | undefined> => ((await (await fetch(`${base}/api/sessions`)).json()) as SessionsResponse).loops[`${id}@r`]
/** エージェントが周の終わりに言う（`sai_loop_next`） */
const next = (id: string, body: object, headers: Record<string, string> = {}) => post(`${base}/api/agent/loop`, { from: `${id}@r`, ...body }, { 'X-SAI-Agent-Token': token, ...headers })
const advance = (seconds: number) => (clock += seconds * 1000)
/** 周のターンを終わらせて、次の時刻が決まるところまで進める */
const endRound = async (id: string) => {
  runner.finish(`${id}@r`)
  return (await poll(id))!
}

test('組むとすぐ 1 周目を送る。エージェントが「続ける（N 秒後）」と言えば、その時刻に次の周を送り、申し送りが次の周の文に入る。「終わり」で止まる', async () => {
  const made = await start('L1')
  assert.deepEqual([made.status, made.round, made.turning], ['running', 1, true])
  const first = runner.sent('L1@r')
  assert.equal(first.length, 1)
  assert.ok(first[0]!.cmd.text.startsWith(`${LOOP_MARK}1 周目 / 上限 10 周`))
  assert.match(first[0]!.cmd.text, /目的: open な PR を片付ける\n終わりの条件: open な PR が 0 件\n前の周の申し送り: （まだありません）/)
  assert.ok(first[0]!.cmd.args.join(' ').includes('SAI_LOOP'), '周のターンにだけ sai_loop_next を出す合図を MCP に渡す')

  const said = await next('L1', { action: 'continue', seconds: 120, note: '#12 をマージした。次は #13 の CI' })
  assert.equal(said.status, 200)
  assert.deepEqual((await said.json()) as LoopNextResponse, { status: 'running', round: 1, max_rounds: 10, next_in_s: 120 })
  assert.equal(runner.sent('L1@r').length, 1, '言っただけでは次を送らない（ターンが終わってから）')

  const waiting = await endRound('L1')
  assert.equal(waiting.turning, undefined)
  assert.equal(waiting.note, '#12 をマージした。次は #13 の CI')
  assert.equal(Date.parse(waiting.next_at!), clock + 120_000)

  advance(119)
  await poll('L1')
  assert.equal(runner.sent('L1@r').length, 1, '時刻が来るまで送らない')
  advance(1)
  const second = (await poll('L1'))!
  assert.deepEqual([second.round, second.turning], [2, true])
  const text = runner.sent('L1@r')[1]!.cmd.text
  assert.ok(text.startsWith(`${LOOP_MARK}2 周目`))
  assert.match(text, /前の周の申し送り: #12 をマージした。次は #13 の CI/)

  const done = await next('L1', { action: 'done', note: 'gh pr list が 0 件' })
  assert.deepEqual((await done.json()) as LoopNextResponse, { status: 'done', round: 2, max_rounds: 10 })
  const ended = await endRound('L1')
  assert.deepEqual([ended.status, ended.reason, ended.next_at], ['done', 'gh pr list が 0 件', undefined])
  advance(3600)
  await poll('L1')
  assert.equal(runner.sent('L1@r').length, 2, '終わったループは起こさない')

  // 詳細の応答にも載り、処理中の本文は「ループ N 周目」になる
  const detail = (await (await fetch(`${base}/api/sessions/${encodeURIComponent('L1@r')}`)).json()) as SessionDetailResponse
  assert.equal(detail.loops['L1@r']!.status, 'done')
  assert.equal(loopPromptLabel(text), 'ループ 2 周目')
})

test('ツールを呼ばずに終わったら既定の間隔で起こす。言われた間隔は下限・上限に丸める', async () => {
  await start('L2', { interval_s: 300 })
  const quiet = await endRound('L2')
  assert.equal(Date.parse(quiet.next_at!), clock + 300_000, '呼ばなければ既定の間隔')
  advance(300)
  await poll('L2')
  assert.equal(((await (await next('L2', { action: 'continue', seconds: 1, note: 'a' })).json()) as LoopNextResponse).next_in_s, LOOP_MIN_INTERVAL_S)
  assert.equal(((await (await next('L2', { action: 'continue', seconds: 999_999, note: 'b' })).json()) as LoopNextResponse).next_in_s, LOOP_MAX_INTERVAL_S)
  assert.equal(((await (await next('L2', { action: 'continue', note: 'c' })).json()) as LoopNextResponse).next_in_s, 300, '秒を言わなければ既定の間隔')
  assert.equal((await next('L2', { action: 'nope' })).status, 400)
  assert.equal((await next('L2', { action: 'done' })).status, 400, '根拠の無い「終わり」は受けない')
  assert.equal((await next('L2', { action: 'give_up', note: '人の判断が要る' })).status, 200)
  assert.deepEqual([(await endRound('L2')).status, (await poll('L2'))!.reason], ['gave_up', '人の判断が要る'])
})

test('上限（周の数・終わりの時刻）で止まる。上限と目的は空・範囲外では組めない', async () => {
  await start('L3', { max_rounds: 2, interval_s: 60 })
  await endRound('L3')
  advance(60)
  assert.equal((await poll('L3'))!.round, 2)
  assert.equal(((await (await next('L3', { action: 'continue', seconds: 60, note: 'まだ' })).json()) as LoopNextResponse).next_in_s, undefined, '最後の周では次の時刻を返さない')
  const capped = await endRound('L3')
  assert.deepEqual([capped.status, capped.reason], ['stopped', '上限の 2 周を回りました'])

  await start('L4', { hours: 0.5, interval_s: 3600 })
  await endRound('L4')
  advance(3600)
  const late = (await poll('L4'))!
  assert.deepEqual([late.status, late.reason, runner.sent('L4@r').length], ['stopped', '終わりの時刻になりました', 1])

  for (const bad of [{ goal: ' ' }, { until: '' }, { max_rounds: 0 }, { max_rounds: 51 }, { max_rounds: 1.5 }, { hours: 25 }, { hours: 0 }, { interval_s: 59 }, { interval_s: 3601 }]) {
    assert.equal((await post(url('L5'), { ...GOAL, ...bad })).status, 400, JSON.stringify(bad))
  }
  assert.equal(await poll('L5'), undefined)
})

test('周のターンが失敗したら止まる。回っている間・預かりがある間は送らない。人が送ったら一時停止し、再開で続く', async () => {
  await start('L5')
  runner.finish('L5@r', true)
  const failed = (await poll('L5'))!
  assert.equal(failed.status, 'stopped')
  assert.match(failed.reason!, /1 周目のターンが失敗しました/)
  runner.busy.delete('L5@r')

  await start('L6', { interval_s: 60 })
  await endRound('L6')
  // 人が送る → 一時停止（次の時刻が来ても起こさない）
  const reply = await post(`${base}/api/sessions/${encodeURIComponent('L6@r')}/reply`, { text: '先にこれを見て' })
  assert.equal(reply.status, 202)
  const paused = (await poll('L6'))!
  assert.equal(paused.status, 'paused')
  assert.match(paused.reason!, /人がこのセッションに送った/)
  runner.finish('L6@r')
  advance(600)
  await poll('L6')
  assert.equal(runner.sent('L6@r').filter((s) => s.cmd.text.startsWith(LOOP_MARK)).length, 1)
  // 再開 → すぐ次の周
  assert.equal((await post(url('L6', '/resume'))).status, 200)
  assert.deepEqual([(await poll('L6'))!.status, (await poll('L6'))!.round], ['running', 2])
  // 周のターンが回っている間（許可・質問で止まっている間もここ）は、時刻が来ても次を送らない。「いま起こす」も断る
  advance(7200 - 601)
  await poll('L6')
  assert.equal(runner.sent('L6@r').filter((s) => s.cmd.text.startsWith(LOOP_MARK)).length, 2)
  assert.equal((await post(url('L6', '/wake'))).status, 409)
  // 止める → 次を起こさない。回っているターンはそのまま
  assert.equal((await post(url('L6', '/stop'))).status, 200)
  assert.equal(runner.running('L6@r'), true)
  assert.equal((await next('L6', { action: 'continue', note: 'x' })).status, 409, '止めたループは動かせない')
  runner.finish('L6@r')
  assert.equal((await poll('L6'))!.status, 'stopped')
  assert.equal((await fetch(url('L6'), { method: 'DELETE' })).status, 200)
  assert.equal(await poll('L6'), undefined)
})

test(`申し送りが ${LOOP_STALL_ROUNDS} 周続けて同じなら止まる。「いま起こす」は次の時刻を待たない`, async () => {
  await start('L7', { interval_s: 600 })
  for (let round = 1; round <= LOOP_STALL_ROUNDS; round++) {
    assert.equal((await poll('L7'))!.round, round)
    assert.equal((await next('L7', { action: 'continue', seconds: 600, note: 'CI を待っている' })).status, 200)
    const ended = await endRound('L7')
    if (round < LOOP_STALL_ROUNDS) {
      assert.equal(ended.status, 'running')
      assert.equal((await post(url('L7', '/wake'))).status, 200)
    } else {
      assert.equal(ended.status, 'stopped')
      assert.match(ended.reason!, /進んでいない/)
    }
  }
})

test('使用量の枠が残り少なければ止める', async () => {
  await start('L8', { interval_s: 60 })
  await endRound('L8')
  usage.value = { claude: { primary: { used_percent: 90, window_minutes: 300, resets_at: Math.floor(Date.now() / 1000) + 3600 } } } as unknown as UsageResponse
  try {
    advance(60)
    const over = (await poll('L8'))!
    assert.equal(over.status, 'stopped')
    assert.match(over.reason!, /5 時間の枠/)
    assert.equal(runner.sent('L8@r').length, 1)
  } finally {
    usage.value = {}
  }
})

test('組めないセッション: Claude 以外・端末で開いている・素通し・別のマシン。もう組んであれば 409', async () => {
  const refuse = async (id: string) => ((await (await post(url(id), GOAL)).json()) as { error: string }).error
  assert.match(await refuse('X1'), /Claude のセッションだけ/)
  assert.match(await refuse('T1'), /端末で開いている/)
  assert.ok(await refuse('R1'))
  const meta = await fetch(`${base}/api/sessions/${encodeURIComponent('P1@r')}/meta`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ permission_mode: 'bypassPermissions' }) })
  assert.equal(meta.status, 200)
  assert.match(await refuse('P1'), /Bypass permissions/)
  assert.equal((await post(url('nope'), GOAL)).status, 404)
  // 運用者が SAI_CLAUDE_ARGS で素通しを渡しているとき（2 語の形・`=` の 1 語の形・--dangerously-skip-permissions）も組めない
  const savedArgs = process.env.SAI_CLAUDE_ARGS
  try {
    for (const args of ['--permission-mode bypassPermissions', '--permission-mode=bypassPermissions', '--dangerously-skip-permissions']) {
      process.env.SAI_CLAUDE_ARGS = args
      assert.match(await refuse('L9'), /Bypass permissions/, args)
    }
  } finally {
    if (savedArgs === undefined) delete process.env.SAI_CLAUDE_ARGS
    else process.env.SAI_CLAUDE_ARGS = savedArgs
  }
  assert.equal(runner.started.some((s) => ['X1@r', 'T1@r', 'P1@r', 'R1@r'].includes(s.id)), false)
})

test('周を起こす直前に人が止めた・片付けたら、その周は起こさない（古い状態で上書きしない。#640 のレビュー）', async () => {
  // L3 は前のテストで止まっているので組み直せる
  await start('L3', { interval_s: 60 })
  const sent = () => runner.sent('L3@r').length
  await endRound('L3')
  const sentBefore = sent()
  advance(60)
  usage.hook = async () => {
    assert.equal((await post(url('L3', '/stop'))).status, 200)
  }
  const stopped = (await poll('L3'))!
  assert.deepEqual([stopped.status, stopped.reason, sent()], ['stopped', '人が止めました', before])

  assert.equal((await fetch(url('L3'), { method: 'DELETE' })).status, 200)
  await start('L3', { interval_s: 60 })
  await endRound('L3')
  const again = sent()
  advance(60)
  usage.hook = async () => {
    assert.equal((await fetch(url('L3'), { method: 'DELETE' })).status, 200)
  }
  assert.equal(await poll('L3'), undefined, '片付けたループが戻ってこない')
  assert.equal(sent(), again)
})

test('口の守り: 別オリジンからは組めない・止められない。エージェントの口はトークンが要り、別のセッション・周でないターンからは動かせない', async () => {
  const cross = { Origin: 'https://evil.example' }
  assert.equal((await post(url('L9'), GOAL, cross)).status, 403)
  await start('L9', { interval_s: 60 })
  assert.equal((await post(url('L9'), GOAL)).status, 409, 'もう組んである')
  for (const rest of ['/stop', '/resume', '/wake']) assert.equal((await post(url('L9', rest), {}, cross)).status, 403)
  assert.equal((await fetch(url('L9'), { method: 'DELETE', headers: cross })).status, 403)
  assert.equal((await fetch(url('L9'))).status, 405)

  assert.equal((await post(`${base}/api/agent/loop`, { from: 'L9@r', action: 'continue', note: 'x' })).status, 403, 'トークンなし')
  assert.equal((await next('L9', { action: 'continue', note: 'x' }, { Origin: base })).status, 403, 'ブラウザからは通さない')
  // 別のセッション（ループの無い L1 はもう終わっている・ターンも回していない）からは動かせない
  assert.equal((await next('L1', { action: 'done', note: 'x' })).status, 409)
  // ループは組んであるが、いま回っているのは周ではないターン（人の返信）
  await endRound('L9')
  runner.busy.set('L9@r', { since: 'human-turn', text: '人から' })
  try {
    const res = await next('L9', { action: 'done', note: '勝手に終わらせる' })
    assert.equal(res.status, 409)
    assert.match(((await res.json()) as { error: string }).error, /ループの周ではありません/)
    assert.equal((await poll('L9'))!.status, 'running')
  } finally {
    runner.busy.delete('L9@r')
  }
  assert.equal((await post(url('L9', '/stop'))).status, 200)
})

test('立て直しても続き、同じ周を 2 回送らない（loops.json から読み戻す）', async () => {
  const id = 'L4'
  assert.equal((await fetch(url(id), { method: 'DELETE' })).status, 200)
  await start(id, { interval_s: 120 })
  const sentBefore = runner.sent(`${id}@r`).length
  const saved = JSON.parse(await readFile(join(dir, LOOPS_FILE), 'utf-8')) as Record<string, { round: number; turn?: string }>
  assert.equal(saved[`${id}@r`]!.round, 1)
  assert.ok(saved[`${id}@r`]!.turn, '周を送ったことはファイルに残る')

  // 新しいサーバ（前の子はもう居ない）。同じ周は送り直さず、既定の間隔のあとに次の周を送る
  const runner2 = new FakeRunner()
  const app2 = make(runner2)
  const server2 = createServer((req, res) => void app2(req, res))
  await new Promise<void>((resolve) => server2.listen(0, '127.0.0.1', resolve))
  const addr = server2.address()
  const base2 = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`
  const poll2 = async () => ((await (await fetch(`${base2}/api/sessions`)).json()) as SessionsResponse).loops[`${id}@r`]!
  try {
    const picked = await poll2()
    assert.deepEqual([picked.status, picked.round, picked.turning, runner2.started.length], ['running', 1, undefined, 0])
    assert.equal(Date.parse(picked.next_at!), clock + 120_000)
    advance(120)
    assert.equal((await poll2()).round, 2)
    assert.equal(runner2.sent(`${id}@r`).length, 1)
    assert.ok(runner2.sent(`${id}@r`)[0]!.cmd.text.startsWith(`${LOOP_MARK}2 周目`))
  } finally {
    app2.dispose()
    await new Promise<void>((resolve) => server2.close(() => resolve()))
  }
  assert.equal(runner.sent(`${id}@r`).length, before)
})
