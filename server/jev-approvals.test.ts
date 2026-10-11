// 許可のバブルに Jev の確率を載せる（#491）。本物の createApp に偽の Jev の口を渡して、
// 一覧の応答の approvals に確率が付くこと・届いたら rev が変わること・設定で切れること・既定では送らないことを見る
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import type { Server } from 'node:http'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ApprovalLogRow, ReplyingMap, SessionsResponse, SettingsResponse } from '../shared/types.ts'
import { createApp } from './app.ts'
import type { JevJudge } from './approvals/jev.ts'
import { Approvals } from './approvals/approvals.ts'
import { FeedStore } from './rows/store.ts'
import { localDate } from './rows/aggregate.ts'
import { row } from './rows/aggregate.test.ts'
import type { Runner } from './reply/runner.ts'
import { JEV_RULE_STATEMENT } from '../shared/jev.ts'

const runner: Runner = { running: () => false, snapshot: (): ReplyingMap => ({}), start: async () => {} }
const judged: string[] = []
const judge: JevJudge = async (state, statement) => {
  judged.push(state)
  // ルールを聞かれたら（#499）: git のルールは問題なさそう、それ以外のルールは広すぎる
  if (statement === JEV_RULE_STATEMENT) return /rule: Bash\(git /.test(state) ? 0.96 : 0.2
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
    for (let i = 0; i < 20; i++) await settle()
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

  // 答えない理由を reply.log に 1 回だけ残し、ルールの確率を一覧に載せる（#553）
  const listed = (await sessions(base)).approvals['S1@r']!
  assert.deepEqual(listed.find((a) => a.input.command === 'pnpm test')?.jev_rule, { label: 'Bash(pnpm test:*)', safe: 0.2 }, 'この回は 97% でもルールは 20% と見える')
  assert.equal(listed.find((a) => a.input.command === 'rm -rf ~/')?.jev_rule, undefined, 'この回が閾値未満ならルールは聞かない')
  for (let i = 0; i < 3; i++) await put(base, { jev_auto: 0.9 }) // 設定を変えるたびに jevAutoTick が回る
  await drain()
  const skipped = (await readFile(join(feedDir, 'reply.log'), 'utf-8')).split('\n').filter((l) => l.includes('見送り'))
  assert.deepEqual(
    skipped.map((l) => l.replace(/^--- \S+ /, '')),
    [
      'S1@r Jev の自動の常に許可を見送り（この回 97%）: ルール Bash(pnpm test:*) が 20%（閾値 90%）',
      'S1@r Jev の自動の常に許可を見送り（この回 97%）: Bash 以外（mcp__github__push_files）は自動で答えない',
    ],
    '閾値以上なのに答えないものだけ・同じ許可には 1 行だけ（rm -rf は閾値未満なので書かない）',
  )

  // Jev を切ると閾値も 0 に戻る
  const off = (await (await put(base, { jev: false })).json()) as SettingsResponse
  assert.equal(off.jev_auto, 0)
  await put(base, { jev: true })
  assert.equal(((await (await fetch(`${base}/api/settings`)).json()) as SettingsResponse).jev_auto, 0, '入に戻しても自動は切のまま')
})

test('自動で常に許可（#705）: つないだコマンドは部品ごとにルールを聞き、一番低いもので判定する。全部が閾値以上のときだけ答える', async () => {
  judged.length = 0
  const approvals = new Approvals()
  const busy: Runner = { ...runner, running: (id) => id === 'S1@r' }
  const base = await start(approvals, judge, busy)
  const post = async (command: string) => {
    const res = await fetch(`${base}/api/approvals`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: 'S1@r', tool_name: 'Bash', input: { command }, tool_use_id: 't' }) })
    assert.equal(res.status, 201)
    return ((await res.json()) as { approval_id: string }).approval_id
  }
  const drain = async () => {
    for (let i = 0; i < 20; i++) await settle()
  }
  assert.equal((await put(base, { jev: true, jev_auto: 0.9 })).status, 200)

  // 片方のルール（Bash(zzwide:*)）が低い → 自動では答えない。前は先頭の語（git status）のルールだけ聞いて答えていた
  const mixed = await post('git status && zzwide --all')
  const both = await post('git diff --stat && git log --oneline | tail -3')
  await drain()
  assert.equal(await approvals.wait(mixed, 10), null, '一番低い部品で判定する')
  const answer = await approvals.wait(both, 10)
  assert.deepEqual(answer?.updatedPermissions, [
    { type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'git diff:*' }, { toolName: 'Bash', ruleContent: 'git log:*' }], behavior: 'allow', destination: 'localSettings' },
  ], '全部の部品が閾値以上なら、部品ごとのルールで答える（読むだけの tail には書かない）')
  for (const rule of ['git status', 'zzwide', 'git diff', 'git log']) assert.ok(judged.some((st) => st.includes(`rule: Bash(${rule}:*)`)), `${rule} のルールを聞く`)
  assert.ok(!judged.some((st) => st.includes('rule: Bash(tail')), '書かないルールは聞かない')

  // 前のテストが預けたままの許可も引き取られているので、ここで預けたものだけ見る
  const listed = (await sessions(base)).approvals['S1@r']!.filter((a) => /zzwide|git (diff|log)/.test(String(a.input.command)))
  assert.deepEqual(listed.map((a) => [a.input.command, a.always, a.jev_rule]), [
    ['git status && zzwide --all', ['Bash(git status:*)', 'Bash(zzwide:*)'], { label: 'Bash(zzwide:*)', safe: 0.2 }],
  ], '一覧には、書かれるルールの全部と、一番低いルールの確率が出る')
  const log = await readFile(join(feedDir, 'reply.log'), 'utf-8')
  assert.match(log, /見送り（この回 97%）: ルール Bash\(zzwide:\*\) が 20%（閾値 90%）/)
  assert.match(log, /Jev が自動で常に許可（この回 97%、ルール 96%、閾値 90%）: Bash\(git diff:\*\) \+ Bash\(git log:\*\)/)
  await put(base, { jev_auto: 0 })
})

test('設定 paste_to_file（#609）: 既定は切。true / false だけ受け、settings.json に残る', async () => {
  const base = await start(new Approvals())
  // 既定（ファイルにまだ無いとき）は切。ほかのテストが settings.json を書いていても、このキーは書いていない
  assert.equal(((await (await fetch(`${base}/api/settings`)).json()) as SettingsResponse).paste_to_file, false)
  for (const bad of ['true', 1, null]) assert.equal((await put(base, { paste_to_file: bad })).status, 400, JSON.stringify(bad))
  const on = await put(base, { paste_to_file: true })
  assert.equal(on.status, 200)
  assert.equal(((await on.json()) as SettingsResponse).paste_to_file, true)
  assert.equal(JSON.parse(await readFile(join(feedDir, 'settings.json'), 'utf-8')).paste_to_file, true)
  assert.equal(((await (await put(base, { paste_to_file: false })).json()) as SettingsResponse).paste_to_file, false)
})

test('approvals.jsonl に、答えたときの Jev の確率を残す（#749）。聞いていない・届く前・聞けなかったを区別し、コマンドの文字は書かない', async () => {
  const rows = async (): Promise<ApprovalLogRow[]> =>
    (await readFile(join(feedDir, 'approvals.jsonl'), 'utf-8').catch(() => '')).split('\n').filter(Boolean).map((l) => JSON.parse(l) as ApprovalLogRow)
  const drain = async () => {
    for (let i = 0; i < 10; i++) await settle()
  }
  const busy: Runner = { ...runner, running: (id) => id === 'S1@r' }
  /** 預けて、一覧を 1 回読ませて（Jev に聞くのは読んだとき）、人が許可する。足された行を返す */
  const answered = async (base: string, tool_name: string, input: Record<string, unknown>, wait = true): Promise<ApprovalLogRow> => {
    const had = (await rows()).length
    const res = await fetch(`${base}/api/approvals`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: 'S1@r', tool_name, input, tool_use_id: 't' }) })
    const id = ((await res.json()) as { approval_id: string }).approval_id
    await sessions(base)
    if (wait) await drain()
    const ok = await fetch(`${base}/api/approvals/${id}/answer`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base }, body: JSON.stringify({ behavior: 'allow' }) })
    assert.equal(ok.status, 200, await ok.clone().text())
    for (let i = 0; i < 50 && (await rows()).length === had; i++) await settle()
    return (await rows()).at(-1)!
  }

  // 自動は切のまま（人が答える行を見る）。偽の Jev: 遅いもの・失敗するもの・ふつうのもの
  let release: () => void = () => {}
  const slow = new Promise<void>((r) => (release = r))
  const fake: JevJudge = async (state) => {
    if (state.includes('zzslow')) await slow
    if (state.includes('zzbroken')) throw new Error('boom')
    return state.includes('zzrisky') ? 0.123456 : 0.9712
  }
  const approvals = new Approvals()
  const base = await start(approvals, fake, busy)
  await put(base, { jev: true, jev_auto: 0 })

  const got = await answered(base, 'Bash', { command: 'zztool sync --secret-flag' })
  assert.deepEqual([got.by, got.jev, got.jev_none], ['human', 0.971, undefined], '届いていた確率（小数 3 桁）')
  assert.equal((await answered(base, 'Bash', { command: 'zzrisky thing' })).jev, 0.123)
  // 聞いたが、答えるまでに届かなかった
  const pending = await answered(base, 'Bash', { command: 'zzslow thing' }, false)
  assert.deepEqual([pending.jev, pending.jev_none], [undefined, 'pending'])
  release()
  // 聞けなかった
  const failed = await answered(base, 'Bash', { command: 'zzbroken thing' })
  assert.deepEqual([failed.jev, failed.jev_none], [undefined, 'failed'])
  // 質問は Jev に聞かない種類
  const question = await answered(base, 'AskUserQuestion', { questions: [{ question: 'どれにする?', options: [] }] })
  assert.deepEqual([question.jev, question.jev_none], [undefined, 'not_asked'])
  // 確率が届いたあとで Jev を切ってから答えた: 画面にも出していないので、記録にも残さない（#750 のレビュー）
  {
    const had = (await rows()).length
    const res = await fetch(`${base}/api/approvals`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: 'S1@r', tool_name: 'Bash', input: { command: 'zztool late' }, tool_use_id: 't' }) })
    const id = ((await res.json()) as { approval_id: string }).approval_id
    await sessions(base)
    await drain()
    assert.equal((await sessions(base)).approvals['S1@r']!.find((a) => a.approval_id === id)?.jev, 0.9712, '届いている')
    await put(base, { jev: false })
    assert.equal((await fetch(`${base}/api/approvals/${id}/answer`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base }, body: JSON.stringify({ behavior: 'allow' }) })).status, 200)
    for (let i = 0; i < 50 && (await rows()).length === had; i++) await settle()
    const late = (await rows()).at(-1)!
    assert.deepEqual([late.jev, late.jev_none], [undefined, 'not_asked'])
  }
  // Jev を切っている
  await put(base, { jev: false })
  const off = await answered(base, 'Bash', { command: 'zztool other' })
  assert.deepEqual([off.jev, off.jev_none], [undefined, 'not_asked'])

  // 鍵が無い（createApp の既定）
  const plain = new Approvals()
  const base2 = await start(plain, undefined, busy)
  const none = await answered(base2, 'Bash', { command: 'zztool nokey' })
  assert.deepEqual([none.jev, none.jev_none], [undefined, 'not_asked'])

  // コマンドの引数・質問の文は書かない（足したのは確率と理由の種類だけ。`rule` に出るルールの頭は今までどおり）
  const text = JSON.stringify(await rows())
  for (const word of ['secret-flag', 'thing', 'nokey', 'other', 'late', 'どれにする']) assert.ok(!text.includes(word), word)

  // Jev が自動で答えた行にも、その回の確率が残る
  const auto = new Approvals()
  const base3 = await start(auto, judge, busy)
  await put(base3, { jev: true, jev_auto: 0.9 })
  const had = (await rows()).length
  await fetch(`${base3}/api/approvals`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: 'S1@r', tool_name: 'Bash', input: { command: 'git status' }, tool_use_id: 't' }) })
  for (let i = 0; i < 100 && (await rows()).length === had; i++) await settle()
  const byJev = (await rows()).at(-1)!
  assert.deepEqual([byJev.by, byJev.remember, byJev.jev, byJev.jev_none], ['jev', true, 0.97, undefined])
  await put(base3, { jev_auto: 0 })
})

test('自動で今回だけ許可（#749）: ルールを作れない Bash は、この回が閾値以上で、読むだけと分かっているコマンドなら、覚えずに 1 回だけ通す。それ以外・閾値未満・切のときは人に残る', async () => {
  const rows = async (): Promise<ApprovalLogRow[]> =>
    (await readFile(join(feedDir, 'approvals.jsonl'), 'utf-8').catch(() => '')).split('\n').filter(Boolean).map((l) => JSON.parse(l) as ApprovalLogRow)
  const drain = async () => {
    for (let i = 0; i < 20; i++) await settle()
  }
  const busy: Runner = { ...runner, running: (id) => id === 'S1@r' }
  const seen: string[] = []
  // 偽の Jev: `zzlow` を含むコマンドだけ低く、ほかは高い。ルールを聞かれたら数える（今回だけ許可では聞かないはず）
  const fake: JevJudge = async (state, statement) => {
    seen.push(statement === JEV_RULE_STATEMENT ? 'rule' : 'safe')
    return state.includes('zzlow') ? 0.4 : 0.95
  }
  const approvals = new Approvals()
  const base = await start(approvals, fake, busy)
  const post = async (command: string) => {
    const res = await fetch(`${base}/api/approvals`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: 'S1@r', tool_name: 'Bash', input: { command }, tool_use_id: 't' }) })
    return ((await res.json()) as { approval_id: string }).approval_id
  }
  const logBefore = (await readFile(join(feedDir, 'reply.log'), 'utf-8').catch(() => '')).length
  const had = (await rows()).length

  // 自動が切（閾値 0）なら、ルールを作れない形も今までどおり人に残る
  await put(base, { jev: true, jev_auto: 0 })
  const off = await post('echo "zzfirst at $(git rev-parse HEAD)"')
  await drain()
  assert.equal(await approvals.wait(off, 10), null)

  // 入にすると、預かっていた分にも効く: 今回だけ許可（ルールは書かない）
  await put(base, { jev_auto: 0.9 })
  await drain()
  const first = await approvals.wait(off, 10)
  assert.equal(first?.behavior, 'allow')
  assert.equal(first?.updatedPermissions, undefined, '覚えない（画面の [許可] と同じ答え）')
  assert.deepEqual(first?.updatedInput, { command: 'echo "zzfirst at $(git rev-parse HEAD)"' })

  // 預かった時にも動く。サブシェルの中の読むだけのコマンドも通る
  const sub = await post('(git status; git log --oneline -3) # zzcomment')
  // 読むだけと分かっていないもの・閾値未満は人に残る
  const del = await post('echo $(rm -rf zzgone)')
  const commit = await post('git commit -m "zzmsg $(date)"')
  const variable = await post('echo "$ZZVAR"')
  const outside = await post('(ls /tmp/zzout)')
  const secret = await post('(cat .env) # zzenv')
  const opaque = await post('git diff --stat $(git rev-parse HEAD)')
  const low = await post('echo "$(git log -1 --format=zzlow)"')
  await drain()
  assert.equal((await approvals.wait(sub, 10))?.behavior, 'allow')
  for (const [id, why] of [[del, '消す'], [commit, '書く'], [variable, '変数'], [outside, 'cwd の外'], [secret, '秘密'], [opaque, '結果を git に渡す'], [low, '閾値未満']] as const) {
    assert.equal(await approvals.wait(id, 10), null, `${why}: 人に残る`)
  }
  assert.ok(!seen.includes('rule'), '今回だけ許可では、ルールの確率を聞かない（書かれるルールが無い）')

  // 記録: by jev・remember false・確率と、ルールを作れなかった理由の種類。コマンドの引数は書かない
  for (let i = 0; i < 50 && (await rows()).length < had + 2; i++) await settle()
  const mine = (await rows()).slice(had)
  assert.deepEqual(mine.map((r) => [r.by, r.behavior, r.remember, r.rule, r.jev, r.no_rule]), [
    ['jev', 'allow', false, '', 0.95, 'expansion'],
    ['jev', 'allow', false, '', 0.95, 'subshell'],
  ])
  for (const word of ['zzfirst', 'zzcomment']) assert.ok(!JSON.stringify(mine).includes(word), word)

  // reply.log: 通した 2 行と、閾値以上なのに通さなかった理由（1 つの許可に 1 行。閾値未満は書かない）。コマンドの文字は入れない
  const log = (await readFile(join(feedDir, 'reply.log'), 'utf-8')).slice(logBefore).split('\n').filter(Boolean).map((l) => l.replace(/^--- \S+ /, ''))
  assert.equal(log.filter((l) => l.startsWith('S1@r Jev が自動で今回だけ許可（この回 95%、閾値 90%。ルールを作れない形: ')).length, 2)
  const skipped = log.filter((l) => l.includes('見送り'))
  assert.deepEqual(skipped.map((l) => l.replace(/^.*見送り（この回 95%）: 今回だけの自動の許可も見送り: /, '')).sort(), [
    '読むだけと分かっているコマンドでない',
    'コマンド置換の結果を、echo 以外に渡している',
    '読める構文だけで書かれていない（変数・バッククォート・ファイルへのリダイレクト・ヒアドキュメント・代入・構文の語など）',
    '読む先・行き先が cwd の外か、読めない形',
    '秘密が入っていそうなファイル（.env・鍵・トークンの類）を読む形',
    'コマンド置換の結果を、echo 以外に渡している',
  ].sort())
  for (let i = 0; i < 3; i++) await put(base, { jev_auto: 0.9 })
  await drain()
  const again = (await readFile(join(feedDir, 'reply.log'), 'utf-8')).slice(logBefore).split('\n').filter((l) => l.includes('見送り'))
  assert.equal(again.length, 6, '同じ許可には 1 行だけ')
  for (const word of ['zzgone', 'zzmsg', 'ZZVAR', 'zzout', 'zzenv']) assert.ok(!again.join('\n').includes(word), word)

  // 画面: 通さなかったものは待ちのまま出ている
  const list = await sessions(base)
  assert.deepEqual(list.approvals['S1@r']!.map((a) => a.approval_id).sort(), [del, commit, variable, outside, secret, opaque, low].sort())

  // 人が残りに答えられる（自動で通さなかっただけで、止めてはいない）
  const ok = await fetch(`${base}/api/approvals/${commit}/answer`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base }, body: JSON.stringify({ behavior: 'allow' }) })
  assert.equal(ok.status, 200)
  await put(base, { jev_auto: 0 })
})
