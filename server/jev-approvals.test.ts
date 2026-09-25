// 許可のバブルに Jev の確率を載せる（#491）。本物の createApp に偽の Jev の口を渡して、
// 一覧の応答の approvals に確率が付くこと・届いたら rev が変わること・設定で切れること・既定では送らないことを見る
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import type { Server } from 'node:http'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ReplyingMap, SessionsResponse, SettingsResponse } from '../shared/types.ts'
import { createApp } from './app.ts'
import type { JevJudge } from './approvals/jev.ts'
import { Approvals } from './approvals/approvals.ts'
import { FeedStore } from './rows/store.ts'
import { localDate } from './rows/aggregate.ts'
import { row } from './rows/aggregate.test.ts'
import type { Runner } from './reply/runner.ts'

const runner: Runner = { running: () => false, snapshot: (): ReplyingMap => ({}), start: async () => {} }
const judged: string[] = []
const judge: JevJudge = async (state) => {
  judged.push(state)
  return state.includes('rm -rf') ? 0.01 : 0.97
}

let dir: string
let feedDir: string
const servers: Server[] = []
const saved: Record<string, string | undefined> = {}

/** createApp を立てて base URL を返す。`jev` を省略すると「送らない」既定のまま */
async function start(approvals: Approvals, jev?: JevJudge | null): Promise<string> {
  const app = createApp(new FeedStore(feedDir), join(dir, 'dist'), runner, approvals, undefined, undefined, undefined, {
    tmux: { run: async () => '' },
    ps: async () => '',
    ...(jev === undefined ? {} : { jev }),
  })
  const server = createServer((req, res) => void app(req, res))
  servers.push(server)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const addr = server.address()
  return `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`
}

const sessions = async (base: string): Promise<SessionsResponse> => (await fetch(`${base}/api/sessions`)).json() as Promise<SessionsResponse>
const settle = () => new Promise((r) => setTimeout(r, 20))

before(async () => {
  // 端末・app-server・opencode serve を見に行かない（許可は Approvals に預けた分だけにする）
  for (const key of ['SAI_TERMINAL', 'SAI_CODEX_APP_SERVER', 'SAI_OPENCODE_SERVER']) {
    saved[key] = process.env[key]
    process.env[key] = '0'
  }
  dir = await mkdtemp(join(tmpdir(), 'sai-jev-'))
  feedDir = join(dir, 'feed')
  await mkdir(feedDir)
  const now = new Date()
  await writeFile(join(feedDir, `${localDate(now.toISOString())}.jsonl`), `${JSON.stringify(row(now, 'S1', { repo: 'r', cwd: dir }))}\n`)
})

after(async () => {
  for (const server of servers) await new Promise<void>((resolve) => server.close(() => resolve()))
  await rm(dir, { recursive: true, force: true })
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
})

test('許可の確率: 最初の応答では付かず、届いたら rev が変わって次の応答に載る。質問には聞かない', async () => {
  const approvals = new Approvals()
  approvals.ask('S1@r', 'Bash', { command: 'git status' }, 't1')
  approvals.ask('S1@r', 'Bash', { command: 'rm -rf ~/' }, 't2')
  approvals.ask('S1@r', 'AskUserQuestion', { questions: [{ question: 'どれにする?', options: [] }] }, 't3')
  const base = await start(approvals, judge)

  const first = await sessions(base)
  assert.deepEqual(first.approvals['S1@r']!.map((a) => a.jev), [undefined, undefined, undefined], '答えを待たずに返す')
  await settle()
  const second = await sessions(base)
  assert.notEqual(second.rev, first.rev, '確率が届いたら rev が変わる（画面が描き直す）')
  const byTool = Object.fromEntries(second.approvals['S1@r']!.map((a) => [a.input.command ?? a.tool_name, a.jev]))
  assert.deepEqual(byTool, { 'git status': 0.97, 'rm -rf ~/': 0.01, AskUserQuestion: undefined })
  assert.equal(judged.length, 2, '質問には聞かない。2 回目のポーリングで聞き直さない')
  assert.ok(judged.every((s) => !s.includes(dir)), 'cwd は送らない')
})

test('設定で切ると聞かず、付けない。設定の応答に入切と鍵の有無が出る', async () => {
  judged.length = 0
  const approvals = new Approvals()
  approvals.ask('S1@r', 'Bash', { command: 'git log' }, 't1')
  const base = await start(approvals, judge)
  const put = await fetch(`${base}/api/settings`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Origin: base },
    body: JSON.stringify({ jev: false }),
  })
  assert.equal(put.status, 200)
  const s = (await put.json()) as SettingsResponse
  assert.equal(s.jev_on, false)
  assert.equal(s.jev_ready, true)
  await sessions(base)
  await settle()
  assert.equal((await sessions(base)).approvals['S1@r']![0]!.jev, undefined)
  assert.equal(judged.length, 0)
  // 入に戻す（ほかのテストのために settings.json を戻す）。型の違う値は 400
  const bad = await fetch(`${base}/api/settings`, { method: 'PUT', headers: { 'Content-Type': 'application/json', Origin: base }, body: JSON.stringify({ jev: 'yes' }) })
  assert.equal(bad.status, 400)
  await fetch(`${base}/api/settings`, { method: 'PUT', headers: { 'Content-Type': 'application/json', Origin: base }, body: JSON.stringify({ jev: true }) })
})

test('createApp の既定は「送らない」（鍵のあるマシンでテストを回しても本物の Jev に送らない）', async () => {
  const prev = process.env.JEV_API_KEY
  process.env.JEV_API_KEY = 'would-be-real-key'
  try {
    const approvals = new Approvals()
    approvals.ask('S1@r', 'Bash', { command: 'git diff' }, 't1')
    const base = await start(approvals)
    const s = (await (await fetch(`${base}/api/settings`)).json()) as SettingsResponse
    assert.equal(s.jev_on, true, '既定は入')
    assert.equal(s.jev_ready, false, '口を渡されていなければ、環境に鍵があっても送れない扱い')
    await sessions(base)
    await settle()
    assert.equal((await sessions(base)).approvals['S1@r']![0]!.jev, undefined)
  } finally {
    if (prev === undefined) delete process.env.JEV_API_KEY
    else process.env.JEV_API_KEY = prev
  }
})

test('自動で常に許可（#499）: 閾値以上の Claude の許可は次の応答で答え済みになり、MCP の待ち手に updatedPermissions 付きの allow が返る。閾値未満・質問・閾値 0 は残る', async () => {
  judged.length = 0
  const approvals = new Approvals()
  const safe = approvals.ask('S1@r', 'Bash', { command: 'git status' }, 't1')
  const risky = approvals.ask('S1@r', 'Bash', { command: 'rm -rf ~/' }, 't2')
  approvals.ask('S1@r', 'AskUserQuestion', { questions: [{ question: 'どれにする?', options: [] }] }, 't3')
  const base = await start(approvals, judge)
  const put = async (body: unknown) => fetch(`${base}/api/settings`, { method: 'PUT', headers: { 'Content-Type': 'application/json', Origin: base }, body: JSON.stringify(body) })

  // 閾値 0（既定）: 0.97 でも残る
  await sessions(base)
  await settle()
  assert.equal((await sessions(base)).approvals['S1@r']!.length, 3, '既定では自動で答えない')

  // 検査: 0.5 未満・1 超・文字列は 400
  for (const bad of [0.3, 1.5, '0.9']) assert.equal((await put({ jev_auto: bad })).status, 400, JSON.stringify(bad))
  const ok = await put({ jev_auto: 0.9 })
  assert.equal(ok.status, 200)
  assert.equal(((await ok.json()) as SettingsResponse).jev_auto, 0.9)
  assert.equal(JSON.parse(await readFile(join(feedDir, 'settings.json'), 'utf-8')).jev_auto, 0.9, 'settings.json に残る')

  const after = await sessions(base)
  const left = Object.fromEntries(after.approvals['S1@r']!.map((a) => [a.input.command ?? a.tool_name, a.jev]))
  assert.deepEqual(left, { 'rm -rf ~/': 0.01, AskUserQuestion: undefined }, '0.97 の git status だけ答え済みで消える。0.01 と質問は残る')
  const answer = await approvals.wait(safe.approval_id, 10)
  assert.equal(answer?.behavior, 'allow')
  assert.deepEqual(answer?.updatedPermissions, [{ type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'git status:*' }], behavior: 'allow', destination: 'localSettings' }], '画面の [常に許可] と同じ答え')
  assert.equal(await approvals.wait(risky.approval_id, 10), null, '危なそうな方はまだ待っている')
  const log = await readFile(join(feedDir, 'reply.log'), 'utf-8')
  assert.match(log, /S1@r Jev が 97% で自動で常に許可（閾値 90%）: /)

  // 閾値ちょうど未満に上げると答えない
  const strict = approvals.ask('S1@r', 'Bash', { command: 'git log' }, 't4')
  await put({ jev_auto: 0.99 })
  await sessions(base)
  await settle()
  await sessions(base)
  assert.equal(await approvals.wait(strict.approval_id, 10), null, '0.97 < 0.99 なので待つ')
  await put({ jev_auto: 0 })
})
