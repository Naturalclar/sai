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
const judge: JevJudge = async (state, statement) => {
  judged.push(state)
  // ルールを聞かれたら（#499）: git のルールは問題なさそう、それ以外のルールは広すぎる
  if (statement?.startsWith('Permanently allowing')) return /rule: Bash\(git /.test(state) ? 0.96 : 0.2
  return state.includes('rm -rf') ? 0.01 : 0.97
}

let dir: string
let feedDir: string
const servers: Server[] = []
const saved: Record<string, string | undefined> = {}

/** createApp を立てて base URL を返す。`jev` を省略すると「送らない」既定のまま */
async function start(approvals: Approvals, jev?: JevJudge | null, run: Runner = runner): Promise<string> {
  const app = createApp(new FeedStore(feedDir), join(dir, 'dist'), run, approvals, undefined, undefined, undefined, {
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
const put = (base: string, body: unknown) => fetch(`${base}/api/settings`, { method: 'PUT', headers: { 'Content-Type': 'application/json', Origin: base }, body: JSON.stringify(body) })

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
  const off = await put(base, { jev: false })
  assert.equal(off.status, 200)
  const s = (await off.json()) as SettingsResponse
  assert.equal(s.jev_on, false)
  assert.equal(s.jev_ready, true)
  await sessions(base)
  await settle()
  assert.equal((await sessions(base)).approvals['S1@r']![0]!.jev, undefined)
  assert.equal(judged.length, 0)
  // 入に戻す（ほかのテストのために settings.json を戻す）。型の違う値は 400
  const bad = await put(base, { jev: 'yes' })
  assert.equal(bad.status, 400)
  await put(base, { jev: true })
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


test('自動で常に許可（#499）: 預かった時に Jev に聞き、この回とルールの両方が閾値以上なら画面のポーリング無しで答える。閾値未満・広いルール・MCP・質問・閾値 0 は残る', async () => {
  judged.length = 0
  const approvals = new Approvals()
  // POST /api/approvals は返信を処理中のセッションだけ受ける
  const busy: Runner = { ...runner, running: (id) => id === 'S1@r' }
  const base = await start(approvals, judge, busy)
  const post = async (tool_name: string, input: Record<string, unknown>) => {
    const res = await fetch(`${base}/api/approvals`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: 'S1@r', tool_name, input, tool_use_id: 't' }) })
    assert.equal(res.status, 201)
    return ((await res.json()) as { approval_id: string }).approval_id
  }
  const drain = async () => {
    for (let i = 0; i < 6; i++) await settle()
  }

  // 閾値 0（既定）: 0.97 でも残る（Jev には聞かない）
  const early = await post('Bash', { command: 'git status' })
  await drain()
  assert.equal(await approvals.wait(early, 10), null, '既定では自動で答えない')
  assert.equal(judged.length, 0, '自動が切なら預かっただけでは聞かない')

  // 検査: 0.5 未満・1 超・文字列は 400
  for (const bad of [0.3, 1.5, '0.9']) assert.equal((await put(base, { jev_auto: bad })).status, 400, JSON.stringify(bad))
  const ok = await put(base, { jev_auto: 0.9 })
  assert.equal(ok.status, 200)
  assert.equal(((await ok.json()) as SettingsResponse).jev_auto, 0.9)
  assert.equal(JSON.parse(await readFile(join(feedDir, 'settings.json'), 'utf-8')).jev_auto, 0.9, 'settings.json に残る')

  // 設定を変えた時にも動く: 預かっていた git status に聞き → ルールも聞き → 答える。一覧の GET は一度も叩いていない
  await drain()
  const answer = await approvals.wait(early, 10)
  assert.equal(answer?.behavior, 'allow')
  assert.deepEqual(answer?.updatedPermissions, [{ type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'git status:*' }], behavior: 'allow', destination: 'localSettings' }], '画面の [常に許可] と同じ答え')
  assert.ok(judged.some((st) => /rule: Bash\(git status:\*\)/.test(st)), 'ルールそのものも聞く')
  const log = await readFile(join(feedDir, 'reply.log'), 'utf-8')
  assert.match(log, /S1@r Jev が自動で常に許可（この回 97%、ルール 96%、閾値 90%）: Bash\(git status:\*\)/)

  // 預かった時にも動く（画面のポーリング無し）。危ないコマンド・広いルール・MCP ツール・質問は残る
  const risky = await post('Bash', { command: 'rm -rf ~/' })
  const wide = await post('Bash', { command: 'pnpm test' }) // この回は 0.97 だが、ルール Bash(pnpm test:*) は 0.2
  const mcp = await post('mcp__github__push_files', { owner: 'o', repo: 'r' })
  const question = await post('AskUserQuestion', { questions: [{ question: 'どれにする?', options: [] }] })
  const fine = await post('Bash', { command: 'git log --oneline' })
  await drain()
  assert.equal((await approvals.wait(fine, 10))?.behavior, 'allow', 'git log は答え済み')
  assert.equal(await approvals.wait(risky, 10), null, '0.01 は待つ')
  assert.equal(await approvals.wait(wide, 10), null, 'この回は通ってもルールが広ければ待つ')
  assert.equal(await approvals.wait(mcp, 10), null, 'MCP ツールは対象外（Jev に引数を送らない）')
  assert.equal(await approvals.wait(question, 10), null, '質問は対象外')
  const left = (await sessions(base)).approvals['S1@r']!.map((a) => a.input.command ?? a.tool_name)
  assert.deepEqual(left, ['rm -rf ~/', 'pnpm test', 'mcp__github__push_files', 'AskUserQuestion'], '一覧にも残っているものだけ出る')

  // Jev を切ると閾値も 0 に戻る
  const off = (await (await put(base, { jev: false })).json()) as SettingsResponse
  assert.equal(off.jev_auto, 0)
  await put(base, { jev: true })
  assert.equal(((await (await fetch(`${base}/api/settings`)).json()) as SettingsResponse).jev_auto, 0, '入に戻しても自動は切のまま')
})
