// 新しいセッションを、記録のあるリポジトリの兄弟 worktree で始める（#319）。本物の createApp と本物の git
// （bare clone + worktree）で、候補の一覧・始める場所の引き当て・git の外の断りを見る
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createServer } from 'node:http'
import type { Server } from 'node:http'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { NewSessionResponse, ReplyingMap, WorkspacesResponse } from '../shared/types.ts'
import { createApp } from './app.ts'
import { Approvals } from './approvals/approvals.ts'
import { worktreeKey } from './git/worktrees.ts'
import { FeedStore } from './rows/store.ts'
import { localDate } from './rows/aggregate.ts'
import { row } from './rows/aggregate.test.ts'
import type { ReplyCommand, Runner } from './reply/runner.ts'

const started: { id: string; cmd: ReplyCommand }[] = []
const runner: Runner = {
  running: () => false,
  snapshot: (): ReplyingMap => ({}),
  start: async (id, cmd) => {
    started.push({ id, cmd })
  },
}

let dir: string
let bare: string
let plain: string
let server: Server
let base: string
const saved = process.env.AGENT_FEED_HOST
const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { stdio: 'pipe' })

const postNew = (body: unknown) =>
  fetch(`${base}/api/sessions/new`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base }, body: JSON.stringify(body) })

before(async () => {
  process.env.AGENT_FEED_HOST = 'testmac'
  dir = await realpath(await mkdtemp(join(tmpdir(), 'sai-new-wt-')))
  const seed = join(dir, 'seed')
  await mkdir(seed)
  git(seed, 'init', '-q', '-b', 'main')
  git(seed, '-c', 'user.email=a@b', '-c', 'user.name=a', 'commit', '-q', '--allow-empty', '-m', 'init')
  bare = join(dir, 'app.git')
  execFileSync('git', ['clone', '-q', '--bare', seed, bare])
  git(bare, 'worktree', 'add', '-q', join(bare, 'dev-a'), '-b', 'dev-a')
  git(bare, 'worktree', 'add', '-q', join(bare, 'dev-b'), '-b', 'dev-b')
  git(bare, 'worktree', 'add', '-q', join(bare, 'dev-c'), '-b', 'dev-c')
  await mkdir(join(bare, 'dev-b', 'sub'))
  // 記録にあるが git の外（`/tmp` や scratchpad の代わり）
  plain = join(dir, 'scratch')
  await mkdir(plain)

  const feedDir = join(dir, 'feed')
  await mkdir(feedDir)
  const now = new Date()
  const lines = [
    row(new Date(now.getTime() - 120_000), 'A1', { repo: 'dev-a', project: 'me/app', cwd: join(bare, 'dev-a'), host: 'testmac' }),
    row(new Date(now.getTime() - 60_000), 'N1', { repo: 'scratch', cwd: plain, host: 'testmac' }),
    row(new Date(now.getTime() - 30_000), 'R1', { repo: 'dev-a', cwd: join(bare, 'dev-a'), host: 'far-away' }),
    // dev-b の下のディレクトリで記録されたもの（#584 のレビュー）。dev-b そのものを「記録なし」で重ねて出さない
    row(new Date(now.getTime() - 20_000), 'B1', { repo: 'dev-b', project: 'me/app', cwd: join(bare, 'dev-b', 'sub'), host: 'testmac' }),
  ]
  await writeFile(join(feedDir, `${localDate(now.toISOString())}.jsonl`), lines.map((l) => JSON.stringify(l)).join('\n') + '\n')
  const app = createApp(new FeedStore(feedDir), join(dir, 'dist'), runner, new Approvals(), undefined, undefined, undefined, {
    tmux: { run: async () => '' },
    ps: async () => '',
  })
  server = createServer((req, res) => void app(req, res))
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const addr = server.address()
  base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`
})

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
  await rm(dir, { recursive: true, force: true })
  if (saved === undefined) delete process.env.AGENT_FEED_HOST
  else process.env.AGENT_FEED_HOST = saved
})

test('GET /api/workspaces: 記録にある cwd は git の作業ツリーの中だけ、同じリポジトリの記録の無い worktree を足す（#319）', async () => {
  const data = (await (await fetch(`${base}/api/workspaces`)).json()) as WorkspacesResponse
  assert.deepEqual(data.recorded, ['B1@dev-b', 'A1@dev-a'], 'git の外（scratch）と別のマシンのものは入らない。新しい順')
  assert.deepEqual(
    data.siblings.map((w) => [w.from, w.repo, w.branch, w.cwd, w.worktree, w.project]),
    [['B1@dev-b', 'dev-c', 'dev-c', join(bare, 'dev-c'), worktreeKey(join(bare, 'dev-c')), 'me/app']],
    '記録のある dev-a・下のディレクトリで記録のある dev-b・bare 本体は出さない',
  )
  assert.equal((await fetch(`${base}/api/workspaces`, { method: 'POST', headers: { Origin: base } })).status, 405, '読むだけ')
})

test('POST /api/sessions/new: 兄弟 worktree は鍵で選び、サーバが一覧を読み直して引き当てる。ID の repo はその worktree 名', async () => {
  started.length = 0
  const res = await postNew({ from: 'A1@dev-a', worktree: worktreeKey(join(bare, 'dev-c')), text: 'はじめて' })
  assert.equal(res.status, 202)
  const data = (await res.json()) as NewSessionResponse
  assert.equal(data.cwd, join(bare, 'dev-c'))
  assert.equal(data.id, `${data.session}@dev-c`, 'record.py が行に書く repo（toplevel の basename）と同じ')
  assert.equal(started[0]?.cmd.cwd, join(bare, 'dev-c'))
  assert.equal(started[0]?.id, data.id)
})

test('POST /api/sessions/new: 鍵が一覧に無い・パスを入れた・git の外の from は断る（パスは受けない）', async () => {
  started.length = 0
  assert.equal((await postNew({ from: 'A1@dev-a', worktree: 'deadbeefdeadbeef', text: 'x' })).status, 400)
  assert.equal((await postNew({ from: 'A1@dev-a', worktree: join(bare, 'dev-c'), text: 'x' })).status, 400, 'パスそのものは鍵にならない')
  // 別のリポジトリの worktree の鍵（from のリポジトリの一覧に無い）
  assert.equal((await postNew({ from: 'A1@dev-a', worktree: worktreeKey('/etc'), text: 'x' })).status, 400)
  const outside = await postNew({ from: 'N1@scratch', text: 'x' })
  assert.equal(outside.status, 400)
  assert.match(((await outside.json()) as { error: string }).error, /git の作業ツリーではない/)
  assert.equal(started.length, 0, '1 つも起動しない')
  // 記録にある worktree そのものは今までどおり（鍵なし）
  const ok = await postNew({ from: 'A1@dev-a', text: 'x' })
  assert.equal(ok.status, 202)
  assert.equal(((await ok.json()) as NewSessionResponse).cwd, join(bare, 'dev-a'))
})
