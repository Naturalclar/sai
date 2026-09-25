// 差分のレビューを Codex に頼む口（#403。`POST /api/sessions/<id>/review`）。本物の createApp に
// 偽の git と app-server を渡して、
// - 未コミット / ブランチの差分の 2 つを `review/start` の target に渡す
// - 比べる相手（base）は差分ビューアと同じ選び方で、リクエストからは受けない
// - Codex 以外・別オリジン・処理中・メソッド違いは断る
// - **ほか（端末の TUI・別の app-server）が開いているスレッドは resume しない**（#430）
// を見る
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import type { Server } from 'node:http'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ReviewResponse } from '../shared/types.ts'
import { createApp } from './app.ts'
import { Approvals } from './approvals/approvals.ts'
import { localDate } from './rows/aggregate.ts'
import { row } from './rows/aggregate.test.ts'
import { FeedStore } from './rows/store.ts'
import { BuildFreshness } from './local/buildFreshness.ts'
import { Authenticator } from './auth.ts'
import type { Git } from './git/diff.ts'
import type { CodexApp, CodexReviewInput } from './reply/codexAppServer.ts'

let dir: string
let work: string
let server: Server
let base: string
const reviewed: CodexReviewInput[] = []
/** 返信を処理中のセッション */
const busy = new Set<string>()
/** writer lock を「開いているプロセスがいる」スレッド（生のID） */
const locked = new Set<string>()
/** SAI の app-server が `thread/resume` 済みのスレッド（生のID） */
const held = new Set<string>()
/** 端末で開いている Codex の pid（行の pane と組で `terminalOf()` が当たる） */
const TUI_PID = 4242

const codexApp: CodexApp = {
  running: (id) => busy.has(id),
  replying: () => ({}),
  snapshot: () => ({}),
  getApproval: () => undefined,
  async start() {},
  answer: () => ({ ok: false, status: 404, error: 'approval not found' }),
  async review(input) {
    reviewed.push(input)
  },
  holds: (threadId) => held.has(threadId),
}

// origin/main だけがあるリポジトリ（ローカルの main は無い）
const git: Git = {
  async run(_cwd, args) {
    if (args[0] === 'symbolic-ref') throw new Error('bare clone では未設定')
    if (args[0] === 'rev-parse' && args.at(-1) === 'origin/main^{commit}') return 'abc123\n'
    throw new Error(`no such ref: ${args.join(' ')}`)
  },
}

before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'sai-review-'))
  work = await mkdtemp(join(tmpdir(), 'sai-review-work-'))
  const now = new Date(Date.now() - 5 * 60_000)
  const rows = [
    JSON.stringify(row(now, 'C1', { agent: 'codex', repo: 'r', cwd: work, pane: '', pid: 0, session_source: 'rollout' })),
    JSON.stringify(row(now, 'A1', { agent: 'claude', repo: 'r', cwd: work, pane: '', pid: 0, session_source: 'payload' })),
    // 端末（tmux のペイン）で開いている Codex
    JSON.stringify(row(now, 'T1', { agent: 'codex', repo: 'r', cwd: work, pane: '%7', pid: TUI_PID, session_source: 'rollout' })),
    // ペインは無いが、別のプロセス（共有の app-server など）が writer lock を握っている Codex
    JSON.stringify(row(now, 'L1', { agent: 'codex', repo: 'r', cwd: work, pane: '', pid: 0, session_source: 'rollout' })),
    // SAI の app-server が resume 済み（lock を開いているのは SAI 自身）
    JSON.stringify(row(now, 'H1', { agent: 'codex', repo: 'r', cwd: work, pane: '', pid: 0, session_source: 'rollout' })),
  ]
  await writeFile(join(dir, `${localDate(now.toISOString())}.jsonl`), rows.join('\n') + '\n')
  const app = createApp(
    new FeedStore(dir),
    join(dir, 'dist'),
    { running: () => false, snapshot: () => ({}), async start() {} },
    new Approvals(),
    new BuildFreshness(join(dir, 'dist'), [], 0),
    undefined,
    new Authenticator(async () => null),
    { tmux: { run: async () => '' }, ps: async () => '', alive: (pid) => pid === TUI_PID, codexWriterActive: async (session) => locked.has(session), codexApp },
    undefined,
    git,
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

const post = (id: string, body: unknown, origin = base) =>
  fetch(`${base}/api/sessions/${encodeURIComponent(id)}/review?days=30`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: origin },
    body: JSON.stringify(body),
  })

test('未コミットの変更を Codex にレビューさせる', async () => {
  reviewed.length = 0
  const res = await post('C1@r', { target: 'uncommittedChanges' })
  assert.equal(res.status, 202)
  const payload = (await res.json()) as ReviewResponse
  assert.equal(payload.target, 'uncommittedChanges')
  assert.equal(payload.session, 'C1', 'CLI に渡す生のIDは行から取る')
  assert.equal(payload.cwd, work)
  assert.equal(payload.base, undefined)
  assert.deepEqual(
    reviewed.map((r) => [r.id, r.threadId, r.cwd, r.target, r.base, r.text]),
    [['C1@r', 'C1', work, 'uncommittedChanges', '', '差分のレビュー（未コミットの変更）']],
  )
  assert.match(await readFile(join(dir, 'reply.log'), 'utf-8'), /review\/start uncommittedChanges/)
})

test('ブランチの差分は、差分ビューアと同じ相手（base）を渡す', async () => {
  reviewed.length = 0
  const res = await post('C1@r', { target: 'baseBranch', base: 'いうことを聞かない値' })
  assert.equal(res.status, 202)
  assert.equal(((await res.json()) as ReviewResponse).base, 'origin/main')
  assert.equal(reviewed[0]?.base, 'origin/main', 'リクエストのブランチ名は見ない')
  assert.equal(reviewed[0]?.text, '差分のレビュー（origin/main との差分）')
})

test('比べる相手が見つからなければ、ターンを起こさずに断る', async () => {
  reviewed.length = 0
  const bare: Git = { async run() { throw new Error('no refs') } }
  const app = createApp(
    new FeedStore(dir),
    join(dir, 'dist'),
    { running: () => false, snapshot: () => ({}), async start() {} },
    new Approvals(),
    new BuildFreshness(join(dir, 'dist'), [], 0),
    undefined,
    new Authenticator(async () => null),
    { tmux: { run: async () => '' }, ps: async () => '', alive: () => false, codexApp },
    undefined,
    bare,
  )
  const one = createServer((req, res) => void app(req, res))
  await new Promise<void>((resolve) => one.listen(0, '127.0.0.1', resolve))
  const addr = one.address()
  const url = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`
  const res = await fetch(`${url}/api/sessions/C1%40r/review?days=30`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: url },
    body: JSON.stringify({ target: 'baseBranch' }),
  })
  assert.equal(res.status, 400)
  assert.deepEqual(reviewed, [])
  await new Promise<void>((resolve) => one.close(() => resolve()))
})

test('Codex 以外・知らない target・別オリジン・処理中・メソッド違いは断る', async () => {
  reviewed.length = 0
  assert.equal((await post('A1@r', { target: 'uncommittedChanges' })).status, 400, 'Claude にはレビューの口が無い')
  assert.equal((await post('C1@r', { target: 'commit' })).status, 400, '画面から選べない target')
  assert.equal((await post('C1@r', {})).status, 400)
  assert.equal((await post('nope@x', { target: 'uncommittedChanges' })).status, 404)
  assert.equal((await post('C1@r', { target: 'uncommittedChanges' }, 'http://evil.example')).status, 403)
  assert.equal((await fetch(`${base}/api/sessions/C1%40r/review`, { method: 'GET' })).status, 405)

  busy.add('C1@r')
  assert.equal((await post('C1@r', { target: 'uncommittedChanges' })).status, 409, '前の返信を処理中なら断る')
  busy.delete('C1@r')
  assert.deepEqual(reviewed, [], 'どれも app-server には渡さない')
})

test('端末で開いている Codex のスレッドは resume せずに断る（#430）', async () => {
  reviewed.length = 0
  const res = await post('T1@r', { target: 'uncommittedChanges' })
  assert.equal(res.status, 400)
  assert.match(((await res.json()) as { error: string }).error, /端末で開いている/)
  assert.deepEqual(reviewed, [], 'app-server に渡さない（渡すと TUI が握っている会話を奪う）')
})

test('ほかのプロセスが writer lock を握っている Codex も断る（#430）', async () => {
  reviewed.length = 0
  locked.add('L1')
  try {
    const res = await post('L1@r', { target: 'uncommittedChanges' })
    assert.equal(res.status, 400)
    assert.match(((await res.json()) as { error: string }).error, /ほかのところ/)
    assert.deepEqual(reviewed, [])
  } finally {
    locked.delete('L1')
  }
})

test('SAI の app-server が握っているスレッドは今までどおり通す（lock を開いているのは SAI 自身。#430）', async () => {
  reviewed.length = 0
  locked.add('H1')
  held.add('H1')
  try {
    const res = await post('H1@r', { target: 'uncommittedChanges' })
    assert.equal(res.status, 202, '自分の持ち物を「ほか」と数えない')
    assert.deepEqual(
      reviewed.map((r) => r.threadId),
      ['H1'],
    )
  } finally {
    locked.delete('H1')
    held.delete('H1')
  }
})
