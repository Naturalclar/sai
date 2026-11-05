// 読むだけなら今回だけ許可（#863）。本物の createApp に偽の git と偽の「止める側のルール」を渡して、
// 既定は切・入にすると読むだけと分かったものだけ覚えずに通す・ask / deny に当たりうる／読めないものは人に残す・Jev を使わない、を見る。
// コマンドは文字列として判定に渡すだけで、実行しない
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import type { Server } from 'node:http'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ApprovalLogRow, ReplyingMap, SettingsResponse } from '../shared/types.ts'
import { createApp } from './app.ts'
import { Approvals } from './approvals/approvals.ts'
import type { JevJudge } from './approvals/jev.ts'
import type { Git } from './git/diff.ts'
import { FeedStore } from './rows/store.ts'
import { localDate } from './rows/aggregate.ts'
import { row } from './rows/aggregate.test.ts'
import type { Runner } from './reply/runner.ts'

let dir: string
let feedDir: string
const servers: Server[] = []
const saved: Record<string, string | undefined> = {}
const busy: Runner = { running: (id) => id === 'S1@r', snapshot: (): ReplyingMap => ({}), start: async () => {} }
/** 偽の git: セッションの cwd（`dir`）が worktree のトップ */
const repoGit: Git = {
  run: async (_cwd, args) => (args[0] === 'worktree' ? `worktree ${await realpath(dir)}\nHEAD 0000000\nbranch refs/heads/main\n` : Promise.reject(new Error('no'))),
}
const settle = () => new Promise((r) => setTimeout(r, 20))
const drain = async () => {
  for (let i = 0; i < 20; i++) await settle()
}

async function start(approvals: Approvals, deps: { guardRules?: (cwd: string) => Promise<string[] | null>; jev?: JevJudge }): Promise<string> {
  const app = createApp(new FeedStore(feedDir), join(dir, 'dist'), busy, approvals, undefined, undefined, undefined, { tmux: { run: async () => '' }, ps: async () => '', ...deps }, undefined, repoGit)
  const server = createServer((req, res) => void app(req, res))
  servers.push(server)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const addr = server.address()
  return `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`
}
const put = (base: string, body: unknown) => fetch(`${base}/api/settings`, { method: 'PUT', headers: { 'Content-Type': 'application/json', Origin: base }, body: JSON.stringify(body) })
const poster = (base: string) => async (command: string) => {
  const res = await fetch(`${base}/api/approvals`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: 'S1@r', tool_name: 'Bash', input: { command }, tool_use_id: 't' }) })
  return ((await res.json()) as { approval_id: string }).approval_id
}
const rows = async (): Promise<ApprovalLogRow[]> =>
  (await readFile(join(feedDir, 'approvals.jsonl'), 'utf-8').catch(() => '')).split('\n').filter(Boolean).map((l) => JSON.parse(l) as ApprovalLogRow)

before(async () => {
  for (const key of ['SAI_TERMINAL', 'SAI_CODEX_APP_SERVER', 'SAI_OPENCODE_SERVER']) {
    saved[key] = process.env[key]
    process.env[key] = '0'
  }
  dir = await mkdtemp(join(tmpdir(), 'sai-read-only-once-'))
  await writeFile(join(dir, '.git'), 'gitdir: /nowhere\n')
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

test('読むだけなら今回だけ許可（#863）: 既定は切。入にすると、ルールを作れない読むだけの Bash だけを覚えずに通し、Jev には聞かない', async () => {
  const judged: string[] = []
  const jev: JevJudge = async (state) => {
    judged.push(state)
    return 0.99
  }
  let guards: string[] | null = []
  const approvals = new Approvals()
  const base = await start(approvals, { guardRules: async () => guards, jev })
  const post = poster(base)
  const had = (await rows()).length

  // 既定は切: 読むだけでも人に残る。true / false 以外は 400
  assert.equal(((await (await fetch(`${base}/api/settings`)).json()) as SettingsResponse).read_only_once, false)
  assert.equal((await put(base, { read_only_once: 'yes' })).status, 400)
  const off = await post('echo "zzfirst at $(git rev-parse HEAD)"')
  await drain()
  assert.equal(await approvals.wait(off, 10), null)

  // 入にすると、預かっていた分にも効く。覚えない（画面の [許可] と同じ答え）
  await put(base, { jev: false })
  const on = await put(base, { read_only_once: true })
  assert.equal(((await on.json()) as SettingsResponse).read_only_once, true)
  await drain()
  const first = await approvals.wait(off, 10)
  assert.equal(first?.behavior, 'allow')
  assert.equal(first?.updatedPermissions, undefined)
  assert.deepEqual(first?.updatedInput, { command: 'echo "zzfirst at $(git rev-parse HEAD)"' })
  assert.match(await readFile(join(feedDir, 'settings.json'), 'utf-8'), /"read_only_once": ?true/)

  // 預かった時にも動く。読むだけと分かっていないもの・ルールを作れる形は人に残る
  const sub = await post('(git status; git log -3 --format=zzcomment%h)')
  const del = await post('echo $(rm -rf zzgone)')
  const variable = await post('echo "$ZZVAR"')
  const outside = await post('(ls /tmp/zzout)')
  const writes = await post('cd zzsub && touch zzmark')
  const ruleable = await post('git status')
  await drain()
  assert.equal((await approvals.wait(sub, 10))?.behavior, 'allow')
  for (const [id, why] of [[del, '消す'], [variable, '変数'], [outside, 'cwd の外'], [writes, 'cd のあとの書き込み'], [ruleable, 'ルールを作れる形は人の [常に許可] に任せる']] as const) {
    assert.equal(await approvals.wait(id, 10), null, why)
  }

  // ask / deny に当たりうる・読めないなら、読むだけでも人に残る
  guards = ['Bash(git log:*)']
  const asked = await post('(git status; git log -3)')
  await drain()
  guards = ['Bash']
  const bare = await post('(git status; pwd)')
  await drain()
  guards = ['Read(./zzsecret/**)']
  const otherTool = await post('(git status; pwd)')
  await drain()
  guards = null
  const unreadable = await post('(git status; pwd)')
  await drain()
  await drain()
  assert.equal(await approvals.wait(asked, 10), null, 'ask に当たりうる')
  assert.equal(await approvals.wait(bare, 10), null, '素の Bash は何にでも当たる')
  assert.equal((await approvals.wait(otherTool, 10))?.behavior, 'allow', 'Bash 以外のルールは見ない')
  assert.equal(await approvals.wait(unreadable, 10), null, '読めなければ答えない')

  // 記録: by read_only・remember false・ルールを作れなかった理由の種類だけ。コマンドの文字は書かない
  for (let i = 0; i < 50 && (await rows()).length < had + 3; i++) await settle()
  const mine = (await rows()).slice(had)
  assert.deepEqual(mine.map((r) => [r.by, r.behavior, r.remember, r.rule, r.no_rule]), [
    ['read_only', 'allow', false, '', 'expansion'],
    ['read_only', 'allow', false, '', 'subshell'],
    ['read_only', 'allow', false, '', 'subshell'],
  ])
  for (const word of ['zzfirst', 'zzcomment']) assert.ok(!JSON.stringify(mine).includes(word), word)
  const log = await readFile(join(feedDir, 'reply.log'), 'utf-8')
  for (const word of ['zzgone', 'ZZVAR', 'zzout', 'zzmark', 'zzfirst']) assert.ok(!log.includes(word), word)
  assert.ok(log.includes('読むだけの今回だけの許可を見送り: 止める側のルール（ask / deny）に当たりうる'))
  assert.equal(judged.length, 0, 'Jev には送らない')
  await put(base, { read_only_once: false })
})

test('読むだけなら今回だけ許可（#863）: createApp の既定は止める側のルールを「読めない」扱いにして、入でも答えない', async () => {
  const approvals = new Approvals()
  const base = await start(approvals, {})
  await put(base, { read_only_once: true })
  const id = await poster(base)('(git status; pwd)')
  await drain()
  assert.equal(await approvals.wait(id, 10), null)
  await put(base, { read_only_once: false })
})
