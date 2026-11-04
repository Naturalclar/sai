// ルールを作れない Bash を部品ごとに見て答える（#863）。本物の createApp に偽のルールの口・偽の git・偽の Jev を渡して、
// 預かった時に答えること・答えた記録が `by: parts` で分かれること・Jev に聞かないこと・当たらないものは人に残ることを見る。
// コマンド・パス・ルールは全部作り物で、**コマンドは 1 つも実行しない**（文字列を預けて答えを見るだけ）
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import type { Server } from 'node:http'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ApprovalLogRow, ReplyingMap } from '../shared/types.ts'
import { createApp } from './app.ts'
import type { TerminalDeps } from './app.ts'
import type { JevJudge } from './approvals/jev.ts'
import { Approvals } from './approvals/approvals.ts'
import type { Git } from './git/diff.ts'
import { FeedStore } from './rows/store.ts'
import { localDate } from './rows/aggregate.ts'
import { row } from './rows/aggregate.test.ts'
import type { Runner } from './reply/runner.ts'

let dir: string
let feedDir: string
const servers: Server[] = []
const saved: Record<string, string | undefined> = {}

/** セッション S1 が SAI の返信を回している（許可を預けられる）。S2 は回していない（端末の Claude と同じく、預けられない） */
const busy: Runner = { running: (id) => id === 'S1@r', snapshot: (): ReplyingMap => ({}), start: async () => {} }
/** 偽の git: セッションの cwd（`dir`）が worktree のトップ。答えるのは `worktree list` だけ */
const repoGit: Git = {
  run: async (_cwd, args) => (args[0] === 'worktree' ? `worktree ${await realpath(dir)}\nHEAD 0000000\nbranch refs/heads/main\n` : Promise.reject(new Error('no'))),
}
/** Jev に聞いたコマンド。部品ごとに答えたものは聞かないはず。低く返すので、Jev の自動はどれにも答えない（答えたのが部品の道だと分かる） */
const asked: string[] = []
const jev: JevJudge = async (state) => {
  asked.push(state)
  return 0.1
}

async function start(approvals: Approvals, rules: TerminalDeps['bashRuleSets']): Promise<string> {
  const app = createApp(
    new FeedStore(feedDir),
    join(dir, 'dist'),
    busy,
    approvals,
    undefined,
    undefined,
    undefined,
    { tmux: { run: async () => '' }, ps: async () => '', jev, ...(rules ? { bashRuleSets: rules } : {}) },
    undefined,
    repoGit,
  )
  const server = createServer((req, res) => void app(req, res))
  servers.push(server)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const addr = server.address()
  return `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`
}

const settle = () => new Promise((r) => setTimeout(r, 20))
const rows = async (): Promise<ApprovalLogRow[]> =>
  (await readFile(join(feedDir, 'approvals.jsonl'), 'utf-8').catch(() => '')).split('\n').filter(Boolean).map((l) => JSON.parse(l) as ApprovalLogRow)

before(async () => {
  // 端末・app-server・opencode serve を見に行かない（許可は Approvals に預けた分だけにする）
  for (const key of ['SAI_TERMINAL', 'SAI_CODEX_APP_SERVER', 'SAI_OPENCODE_SERVER']) {
    saved[key] = process.env[key]
    process.env[key] = '0'
  }
  dir = await mkdtemp(join(tmpdir(), 'sai-composed-'))
  // 作り物の worktree のトップ（`readRoots()` は、トップに `.git` があるものだけ数える）
  await writeFile(join(dir, '.git'), 'gitdir: /nowhere\n')
  await mkdir(join(dir, 'pkg'))
  feedDir = join(dir, 'feed')
  await mkdir(feedDir)
  const now = new Date()
  const lines = [row(now, 'S1', { repo: 'r', cwd: dir }), row(now, 'S2', { repo: 'r', cwd: dir })]
  await writeFile(join(feedDir, `${localDate(now.toISOString())}.jsonl`), lines.map((l) => `${JSON.stringify(l)}\n`).join(''))
})

after(async () => {
  for (const server of servers) await new Promise<void>((resolve) => server.close(() => resolve()))
  await rm(dir, { recursive: true, force: true })
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
})

test('部品ごとに見て答える（#863）: 部品が全部許されていて、つなぎ方が安全な形なら、預かった時に今回だけ許可で答え、by: parts で残す。Jev には聞かない', async () => {
  let rules = { allow: ['Bash(tool-a build:*)', 'Bash(tool-b *)'], block: [] as string[] }
  const approvals = new Approvals()
  const base = await start(approvals, async () => rules)
  await fetch(`${base}/api/settings`, { method: 'PUT', headers: { 'Content-Type': 'application/json', Origin: base }, body: JSON.stringify({ jev: true, jev_auto: 0.9 }) })
  const post = async (id: string, command: string) =>
    fetch(`${base}/api/approvals`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id, tool_name: 'Bash', input: { command }, tool_use_id: 't' }) })
  const ask = async (command: string) => ((await (await post('S1@r', command)).json()) as { approval_id: string }).approval_id
  const had = (await rows()).length

  // どれも「常に許可」のルールを組めない形（$( … )・for）。ルールの部品と読むだけの部品の組み合わせ・パイプの後ろ・for・$( … )・リポジトリの中への cd
  const mixed = await ask('tool-a build zzmixed "$(git rev-parse HEAD)" && git status')
  const piped = await ask('tool-a build zzpiped $(tool-b x) | head -5')
  const loop = await ask('for f in zza zzb; do tool-b $f; done')
  const sub = await ask('tool-b "$(tool-a build zzsub)"')
  const cd = await ask(`cd ${dir}/pkg && tool-a build zzcd "$(git rev-parse HEAD)"`)
  for (const [id, what] of [[mixed, 'ルール + 読むだけ'], [piped, 'パイプの後ろ'], [loop, 'for'], [sub, '$( … )'], [cd, 'リポジトリの中への cd']] as const) {
    const answer = await approvals.wait(id, 10)
    assert.equal(answer?.behavior, 'allow', what)
    assert.equal(answer?.updatedPermissions, undefined, `${what}: 覚えない（新しい許可を作らない）`)
  }

  // 人に残るもの: 当たらない部品・ファイルに書く・ヒアドキュメント・代入・変数・サブシェル・外への cd・ルールを組める形
  const left = {
    当たらない部品: await ask('tool-a build x && tool-z y'),
    ファイルに書く: await ask('tool-a build x > zzout.txt && tool-b'),
    ヒアドキュメント: await ask("tool-b <<'EOF'\nzz\nEOF"),
    代入: await ask('X=1 tool-a build && tool-b'),
    変数: await ask('tool-b $ZZ && tool-a build'),
    サブシェル: await ask('(tool-a build) && tool-b'),
    外への_cd: await ask('cd /zz/outside && tool-a build'),
    ルールを組める形: await ask('tool-z run'),
  }
  // ask / deny に当たりうる部品
  rules = { allow: rules.allow, block: ['Bash(tool-b:*)'] }
  const blocked = await ask('tool-a build x && tool-b "$(tool-a build y)"')
  for (const [what, id] of [...Object.entries(left), ['ask / deny', blocked] as const]) assert.equal(await approvals.wait(id, 10), null, `${what}: 人に残る`)

  // 端末の Claude（SAI が返信を回していないセッション）は、そもそも預けられない
  assert.equal((await post('S2@r', 'tool-a build x && git status')).status, 409)

  // 記録: by parts・remember false・ルールを作れなかった理由・部品ごとの根拠の数。コマンドの文字は書かない
  for (let i = 0; i < 50 && (await rows()).length < had + 5; i++) await settle()
  const mine = (await rows()).slice(had)
  assert.deepEqual(mine.map((r) => [r.by, r.behavior, r.remember, r.rule, r.parts_rule, r.parts_read]), [
    ['parts', 'allow', false, '', 1, 2],
    ['parts', 'allow', false, '', 2, 1],
    ['parts', 'allow', false, '', 2, 0],
    ['parts', 'allow', false, '', 2, 0],
    ['parts', 'allow', false, '', 1, 1],
  ])
  assert.ok(mine.every((r) => r.no_rule), 'ルールを作れなかった理由の種類を添える')
  const text = JSON.stringify(mine)
  for (const word of ['zzmixed', 'zzpiped', 'zza', 'zzsub', 'zzcd', 'tool-a']) assert.ok(!text.includes(word), `記録に ${word} を書かない`)
  for (const word of ['zzmixed', 'zzpiped', 'zza', 'zzsub', 'zzcd']) assert.ok(!asked.some((s) => s.includes(word)), `部品ごとに答えたもの（${word}）は Jev に聞かない`)
  assert.ok(asked.some((s) => s.includes('tool-z')), '人に残ったものは、今までどおり Jev に聞く')
})

test('部品ごとに見て答える（#863）: createApp の既定（ルールの口を渡さない）・ルールが読めないときは答えない', async () => {
  for (const rules of [undefined, async () => null]) {
    const approvals = new Approvals()
    const base = await start(approvals, rules)
    const res = await fetch(`${base}/api/approvals`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: 'S1@r', tool_name: 'Bash', input: { command: 'git status && git log -3' }, tool_use_id: 't' }) })
    const id = ((await res.json()) as { approval_id: string }).approval_id
    for (let i = 0; i < 5; i++) await settle()
    assert.equal(await approvals.wait(id, 10), null)
  }
})

test('部品ごとに見て答える（#863）: cwd が worktree のトップより下なら、トップの ask / deny も見る（許可のルールは cwd から読む）', async () => {
  const sub = join(await realpath(dir), 'pkg')
  const now = new Date()
  await writeFile(join(feedDir, `${localDate(now.toISOString())}.jsonl`), `${JSON.stringify(row(now, 'S1', { repo: 'r', cwd: sub }))}\n`, { flag: 'a' })
  const read: string[] = []
  const approvals = new Approvals()
  const base = await start(approvals, async (at) => {
    read.push(at)
    return at === sub ? { allow: ['Bash(tool-a build:*)'], block: [] } : { allow: [], block: ['Bash(tool-a:*)'] }
  })
  const res = await fetch(`${base}/api/approvals`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: 'S1@r', tool_name: 'Bash', input: { command: 'tool-a build "$(git rev-parse HEAD)"' }, tool_use_id: 't' }) })
  const id = ((await res.json()) as { approval_id: string }).approval_id
  for (let i = 0; i < 5; i++) await settle()
  assert.equal(await approvals.wait(id, 10), null, 'トップの deny に当たるので人に残る')
  assert.deepEqual([...new Set(read)].sort(), [await realpath(dir), sub].sort())
})
