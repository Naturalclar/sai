// 新しい worktree と新しいセッションの案（#892 の段階 1。`sai_start` → `POST /api/agent/start`）。本物の createApp を、偽の Runner・偽の git・
// 偽の worktree を作る口で回す。**git もプロセスも本物は起こさない**（`claude agents`・`gh` も偽物）。本物の ~/.agent-feed は触らない
import { after, before, beforeEach, test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import type { Server } from 'node:http'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { START_DRAFT_TTL_MS } from '../shared/startDraft.ts'
import { WAIT_MARK } from '../shared/waits.ts'
import type { AddWorktreeResponse, AgentStartResponse, NewSessionResponse, Replying, SessionsResponse, SessionSummary, StartDraftActionResponse } from '../shared/types.ts'
import { createApp } from './app.ts'
import type { App } from './app.ts'
import { Approvals } from './approvals/approvals.ts'
import { Authenticator } from './auth.ts'
import type { Git } from './git/diff.ts'
import { NoPr } from './git/pr.ts'
import { NoPrs } from './git/prs.ts'
import { worktreeKey } from './git/worktrees.ts'
import { BuildFreshness } from './local/buildFreshness.ts'
import { NoAgents } from './local/claudeAgents.ts'
import type { ProgressReader } from './local/progress.ts'
import type { UsageStore } from './local/usage.ts'
import { SkillStore } from './local/skills.ts'
import { AGENT_TOKEN_FILE } from './reply/agentMessages.ts'
import type { CodexApp } from './reply/codexAppServer.ts'
import type { ReplyCommand, Runner } from './reply/runner.ts'
import { START_DRAFTS_FILE } from './reply/startDrafts.ts'
import { localDate } from './rows/aggregate.ts'
import { row } from './rows/aggregate.test.ts'
import { FeedStore } from './rows/store.ts'

/** 起動したら「処理中」にする（本物と同じ）。`finish()` で終わらせる */
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
    // 本物と同じく、起こしたときの許可モードを覚える（#895 のレビュー）
    this.busy.set(id, { since: new Date().toISOString(), text: cmd.text, ...(cmd.permissionMode !== undefined ? { permission_mode: cmd.permissionMode } : {}) })
  }
  finish(id: string) {
    this.busy.delete(id)
  }
}

/** `git worktree list --porcelain` と、ブランチ・base の有無だけを答える偽物（worktree-add.test.ts と同じ形） */
class FakeGit implements Git {
  bare: string | null = null
  trees: string[] = []
  calls: string[][] = []
  run(_cwd: string, args: string[]): Promise<string> {
    this.calls.push(args)
    if (args[0] === 'worktree' && args[1] === 'list') {
      const blocks = [...(this.bare ? [`worktree ${this.bare}\nbare\n`] : []), ...this.trees.map((t) => `worktree ${t}\nHEAD 0\nbranch refs/heads/x\n`)]
      return Promise.resolve(blocks.join('\n'))
    }
    if (args[0] === 'rev-parse') {
      const ref = String(args.at(-1)).replace(/\^\{commit\}$/, '')
      return ref === 'main' ? Promise.resolve('0\n') : Promise.reject(new Error('unknown'))
    }
    return Promise.reject(new Error(`呼ばれない形: ${args.join(' ')}`))
  }
}

const codexApp: CodexApp = { running: () => false, replying: () => ({}), snapshot: () => ({}), getApproval: () => undefined, async start() {}, answer: () => ({ ok: false, status: 404, error: 'approval not found' }) }
const usage = { async get() { return {} } }
const progress = { async read(s: Pick<SessionSummary, 'id'>) { return { rev: '', id: s.id, active: false, steps: [], total: 0, updated_at: '', context_tokens: 0 } } }

let dir: string
let feedDir: string
let bare: string
let server: Server
let bareServer: Server
let base: string
let bareBase: string
let token: string
let app: App
let bareApp: App
const runner = new FakeRunner()
const bareRunner = new FakeRunner()
const fake = new FakeGit()
const adds: { cwd: string; name: string; path: string }[] = []
const saved = process.env.AGENT_FEED_HOST

const make = (store: FeedStore, r: Runner, adder: boolean) =>
  createApp(
    store,
    join(dir, 'dist'),
    r,
    new Approvals(),
    new BuildFreshness(join(dir, 'dist'), [], 0),
    undefined,
    new Authenticator(async () => null),
    {
      tmux: { run: async () => { throw new Error('unused') } },
      ps: async () => '',
      codexApp,
      ...(adder
        ? {
            worktreeAdder: {
              add: async (cwd: string, name: string, path: string) => {
                adds.push({ cwd, name, path })
                await mkdir(path)
                fake.trees.push(path)
              },
            },
          }
        : {}),
    },
    new SkillStore(),
    fake,
    new NoPr(),
    usage as unknown as UsageStore,
    progress as unknown as ProgressReader,
    new NoAgents(),
    new NoPrs(),
  )

const listen = async (a: App): Promise<[Server, string]> => {
  const s = createServer((req, res) => void a(req, res))
  await new Promise<void>((resolve) => s.listen(0, '127.0.0.1', resolve))
  const addr = s.address()
  return [s, `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`]
}

before(async () => {
  process.env.AGENT_FEED_HOST = 'testmac'
  dir = await realpath(await mkdtemp(join(tmpdir(), 'sai-start-draft-')))
  bare = join(dir, 'app.git')
  await mkdir(join(bare, 'dev-a'), { recursive: true })
  feedDir = join(dir, 'feed')
  await mkdir(feedDir)
  const now = new Date()
  const cwd = join(bare, 'dev-a')
  const lines = [
    row(new Date(now.getTime() - 60_000), 'A1', { repo: 'dev-a', project: 'owner-a/repo-a', remote: 'https://github.com/owner-a/repo-a', cwd, host: 'testmac' }),
    row(new Date(now.getTime() - 50_000), 'P1', { repo: 'dev-a', project: 'owner-a/repo-a', remote: 'https://github.com/owner-a/repo-a', cwd, host: 'testmac' }),
    ...['Q1', 'S1', 'W1', 'E1'].map((id, i) => row(new Date(now.getTime() - 40_000 + i * 1000), id, { repo: 'dev-a', project: 'owner-a/repo-a', remote: 'https://github.com/owner-a/repo-a', cwd, host: 'testmac' })),
  ]
  await writeFile(join(feedDir, `${localDate(now.toISOString())}.jsonl`), lines.map((l) => JSON.stringify(l)).join('\n') + '\n')
  app = make(new FeedStore(feedDir), runner, true)
  token = (await readFile(join(feedDir, AGENT_TOKEN_FILE), 'utf-8')).trim()
  ;[server, base] = await listen(app)
  // worktree を作る口の無い SAI（`createApp` の既定）
  const bareFeed = join(dir, 'feed-bare')
  await mkdir(bareFeed)
  await writeFile(join(bareFeed, `${localDate(now.toISOString())}.jsonl`), JSON.stringify(lines[0]) + '\n')
  bareApp = make(new FeedStore(bareFeed), bareRunner, false)
  ;[bareServer, bareBase] = await listen(bareApp)
})

beforeEach(() => {
  fake.bare = bare
  fake.trees = [join(bare, 'dev-a')]
  fake.calls.length = 0
  adds.length = 0
})

after(async () => {
  app.dispose()
  bareApp.dispose()
  await new Promise<void>((resolve) => server.close(() => resolve()))
  await new Promise<void>((resolve) => bareServer.close(() => resolve()))
  await rm(dir, { recursive: true, force: true })
  if (saved === undefined) delete process.env.AGENT_FEED_HOST
  else process.env.AGENT_FEED_HOST = saved
})

const post = (target: string, body: unknown = {}, headers: Record<string, string> = {}) => fetch(target, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) })
const errorOf = async (res: Response) => ((await res.json()) as { error: string }).error
const turn = async (at: string, id: string, text = '割り振って') => {
  const res = await post(`${at}/api/sessions/${encodeURIComponent(id)}/reply`, { text })
  assert.equal(res.status, 202, await res.clone().text())
}
const place = (body: unknown, headers: Record<string, string> = { 'X-SAI-Agent-Token': token }, at = base) => post(`${at}/api/agent/start`, body, headers)
const sessionOf = async (id: string, at = base) => ((await (await fetch(`${at}/api/sessions`)).json()) as SessionsResponse).sessions.find((s) => s.id === id)

test('POST /api/agent/start: いま回しているターンのセッションが置ける。置くだけで git もプロセスも起こさず、要対応に出す分が一覧に載る（#892）', async () => {
  await turn(base, 'A1@dev-a')
  const startedBefore = runner.started.length
  fake.calls.length = 0
  const res = await place({ from: 'A1@dev-a', name: 'task-x', agent: 'codex', text: '  issue の続きをやって  ', cwd: '/etc', repo: 'owner-b/repo-b', branch: 'evil', base: '--force', path: '/tmp/x' })
  assert.equal(res.status, 201, await res.clone().text())
  const { draft } = (await res.json()) as AgentStartResponse
  assert.deepEqual({ ...draft, at: 0 }, { name: 'task-x', agent: 'codex', text: 'issue の続きをやって', at: 0 }, 'パス・リポジトリ・ブランチ・base は受けない')
  assert.equal(runner.started.length, startedBefore, 'プロセスは起こさない')
  assert.deepEqual(adds, [], 'worktree は作らない')
  assert.deepEqual(fake.calls, [], 'git も叩かない（置く口を呼んだ間）')
  const stored = JSON.parse(await readFile(join(feedDir, START_DRAFTS_FILE), 'utf-8')) as Record<string, unknown>
  assert.deepEqual(Object.keys(stored), ['A1@dev-a'])
  const s = await sessionOf('A1@dev-a')
  assert.deepEqual(s?.start_draft, draft)
  // 置き直すと前の案は消える（1 セッションに 1 つ）
  const again = await place({ from: 'A1@dev-a', name: 'task-y', text: '別の作業' })
  assert.equal(again.status, 201)
  assert.deepEqual([(await sessionOf('A1@dev-a'))?.start_draft?.name, (await sessionOf('A1@dev-a'))?.start_draft?.agent], ['task-y', 'claude'], 'エージェントの既定は claude')
  runner.finish('A1@dev-a')
})

test('POST /api/agent/start: 案から押すと、今の画面の道（POST /api/workspaces → POST /api/sessions/new）で、置いたセッションのリポジトリに作って始まる（#892）', async () => {
  await turn(base, 'A1@dev-a')
  const placed = (await (await place({ from: 'A1@dev-a', name: 'task-z', text: 'はじめて' })).json()) as AgentStartResponse
  runner.finish('A1@dev-a')
  // 画面（`startFromDraft()`）がすることを、同じ順に
  const made = await post(`${base}/api/workspaces`, { from: 'A1@dev-a', name: placed.draft.name }, { Origin: base })
  assert.equal(made.status, 201, await made.clone().text())
  const { worktree } = (await made.json()) as AddWorktreeResponse
  const path = join(bare, 'task-z')
  assert.deepEqual(adds, [{ cwd: join(bare, 'dev-a'), name: 'task-z', path }], '置き場は置いたセッションの行の cwd のリポジトリの隣')
  assert.equal(worktree.worktree, worktreeKey(path))
  const startedBefore = runner.started.length
  const begun = await post(`${base}/api/sessions/new`, { from: worktree.from, worktree: worktree.worktree, text: placed.draft.text }, { Origin: base })
  assert.equal(begun.status, 202, await begun.clone().text())
  assert.equal(((await begun.json()) as NewSessionResponse).cwd, path)
  assert.equal(runner.started.length, startedBefore + 1)
  assert.equal(runner.started.at(-1)?.cmd.cwd, path)
  // 同じ名前でもう一度押すと、今の画面と同じく断る（#892 の「決めること」2）
  assert.equal((await post(`${base}/api/workspaces`, { from: 'A1@dev-a', name: 'task-z' }, { Origin: base })).status, 409)
  // 始めたら片付ける。`at` が違えば片付けない
  const wrong = (await (await post(`${base}/api/sessions/${encodeURIComponent('A1@dev-a')}/start-draft`, { at: placed.draft.at + 1 }, { Origin: base })).json()) as StartDraftActionResponse
  assert.equal(wrong.taken, false)
  const taken = (await (await post(`${base}/api/sessions/${encodeURIComponent('A1@dev-a')}/start-draft`, { at: placed.draft.at }, { Origin: base })).json()) as StartDraftActionResponse
  assert.equal(taken.taken, true)
  assert.equal((await sessionOf('A1@dev-a'))?.start_draft, undefined)
  runner.finish(runner.started.at(-1)!.id)
})

test('POST /api/agent/start: トークン無し・ブラウザから・回していないセッション・悪い名前・知らないエージェント・空の指示は断る（#892）', async () => {
  assert.equal((await place({ from: 'A1@dev-a', name: 'task-x', text: 'x' }, {})).status, 403, 'トークンが要る')
  assert.equal((await place({ from: 'A1@dev-a', name: 'task-x', text: 'x' }, { 'X-SAI-Agent-Token': token, Origin: base })).status, 403, 'ブラウザからは通さない')
  assert.equal((await place({ from: 'A1@dev-a', name: 'task-x', text: 'x' })).status, 409, 'SAI から回しているターンでなければ置けない')
  await turn(base, 'A1@dev-a')
  for (const name of ['..', '../repo-b', 'a/b', '-b', '--force', join(dir, 'x'), '', 'HEAD', 7]) {
    const res = await place({ from: 'A1@dev-a', name, text: 'x' })
    assert.equal(res.status, 400, String(name))
    assert.match(await errorOf(res), /worktree の名前/)
  }
  assert.equal((await place({ from: 'A1@dev-a', name: 'task-x', agent: 'grok', text: 'x' })).status, 400)
  assert.equal((await place({ from: 'A1@dev-a', name: 'task-x', text: '   ' })).status, 400)
  assert.equal((await place({ from: 'A1@dev-a', name: 'task-x', text: 'x'.repeat(4001) })).status, 400)
  assert.deepEqual(adds, [])
  runner.finish('A1@dev-a')
})

test('POST /api/agent/start: 許可を聞かないモードのセッションからは置かせない。worktree を作る口が無い SAI でも置かない（#892）', async () => {
  const meta = await fetch(`${base}/api/sessions/${encodeURIComponent('P1@dev-a')}/meta`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ permission_mode: 'bypassPermissions' }) })
  assert.equal(meta.status, 200, await meta.clone().text())
  await turn(base, 'P1@dev-a')
  const res = await place({ from: 'P1@dev-a', name: 'task-x', text: 'x' })
  assert.equal(res.status, 403)
  assert.match(await errorOf(res), /許可を聞かないモード/)
  assert.equal((await sessionOf('P1@dev-a'))?.start_draft, undefined)
  runner.finish('P1@dev-a')

  await turn(bareBase, 'A1@dev-a')
  const none = await place({ from: 'A1@dev-a', name: 'task-x', text: 'x' }, { 'X-SAI-Agent-Token': (await readFile(join(dir, 'feed-bare', AGENT_TOKEN_FILE), 'utf-8')).trim() }, bareBase)
  assert.equal(none.status, 409)
  assert.match(await errorOf(none), /worktree を作る口がありません/)
  bareRunner.finish('A1@dev-a')
})

test('POST /api/sessions/<id>/start-draft: 同一オリジンのみ。24 時間を過ぎた案は一覧に載せない（#892）', async () => {
  await turn(base, 'A1@dev-a')
  const placed = (await (await place({ from: 'A1@dev-a', name: 'task-old', text: 'x' })).json()) as AgentStartResponse
  runner.finish('A1@dev-a')
  assert.equal((await post(`${base}/api/sessions/${encodeURIComponent('A1@dev-a')}/start-draft`, { at: placed.draft.at }, { Origin: 'http://evil.example' })).status, 403)
  assert.equal((await post(`${base}/api/sessions/${encodeURIComponent('A1@dev-a')}/start-draft`, {}, { Origin: base })).status, 400)
  // 置いた時刻を 24 時間前にずらす（置き場のファイルを書き換える）
  const file = join(feedDir, START_DRAFTS_FILE)
  const stored = JSON.parse(await readFile(file, 'utf-8')) as Record<string, { at: number }>
  stored['A1@dev-a']!.at = Date.now() - START_DRAFT_TTL_MS - 1000
  await writeFile(file, JSON.stringify(stored) + '\n')
  assert.equal((await sessionOf('A1@dev-a'))?.start_draft, undefined)
})

const putMeta = async (id: string, permission_mode: string) => {
  const res = await fetch(`${base}/api/sessions/${encodeURIComponent(id)}/meta`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ permission_mode }) })
  assert.equal(res.status, 200, await res.clone().text())
}

test('POST /api/agent/start: 素通しで起こしたターンは、あとでメタを戻しても置けない。運用者が SAI_CLAUDE_ARGS で素通しにしていても置けない（#895 のレビュー）', async () => {
  await putMeta('Q1@dev-a', 'bypassPermissions')
  await turn(base, 'Q1@dev-a')
  await putMeta('Q1@dev-a', 'acceptEdits')
  const res = await place({ from: 'Q1@dev-a', name: 'task-x', text: 'x' })
  assert.equal(res.status, 403)
  assert.match(await errorOf(res), /許可を聞かないモード/)
  runner.finish('Q1@dev-a')

  await turn(base, 'E1@dev-a')
  const savedArgs = process.env.SAI_CLAUDE_ARGS
  process.env.SAI_CLAUDE_ARGS = '--dangerously-skip-permissions'
  try {
    const env = await place({ from: 'E1@dev-a', name: 'task-x', text: 'x' })
    assert.equal(env.status, 403)
  } finally {
    if (savedArgs === undefined) delete process.env.SAI_CLAUDE_ARGS
    else process.env.SAI_CLAUDE_ARGS = savedArgs
  }
  assert.equal((await sessionOf('E1@dev-a'))?.start_draft, undefined)
  runner.finish('E1@dev-a')
})

test('POST /api/agent/start: 送信を止めたセッション・待ちで起きたターンからは置けない（#895 のレビュー）', async () => {
  await turn(base, 'S1@dev-a')
  assert.equal((await post(`${base}/api/sessions/${encodeURIComponent('S1@dev-a')}/agent/stop`, {}, { Origin: base })).status, 200)
  const stopped = await place({ from: 'S1@dev-a', name: 'task-x', text: 'x' })
  assert.equal(stopped.status, 409)
  assert.match(await errorOf(stopped), /送信を止めている/)
  await post(`${base}/api/sessions/${encodeURIComponent('S1@dev-a')}/agent/resume`, {}, { Origin: base })
  runner.finish('S1@dev-a')

  await turn(base, 'W1@dev-a', `${WAIT_MARK} PR の CI が終わりました`)
  const woke = await place({ from: 'W1@dev-a', name: 'task-x', text: 'x' })
  assert.equal(woke.status, 409)
  assert.match(await errorOf(woke), /待ちで起きたターン/)
  runner.finish('W1@dev-a')
})

test('一覧の rev: 案を置いた・片付けたで変わる（3 秒のポーリングが再描画する）（#895 のレビュー）', async () => {
  const revOf = async () => ((await (await fetch(`${base}/api/sessions`)).json()) as SessionsResponse).rev
  const revBefore = await revOf()
  await turn(base, 'A1@dev-a')
  const placed = (await (await place({ from: 'A1@dev-a', name: 'task-r', text: 'x' })).json()) as AgentStartResponse
  runner.finish('A1@dev-a')
  const withDraft = await revOf()
  assert.notEqual(withDraft, revBefore)
  await post(`${base}/api/sessions/${encodeURIComponent('A1@dev-a')}/start-draft`, { at: placed.draft.at }, { Origin: base })
  assert.notEqual(await revOf(), withDraft)
})
