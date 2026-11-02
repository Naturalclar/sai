// 画面から新しい worktree を作る（#847）。**git は全部偽物**で、本物のリポジトリに worktree を作らない。
// 置き場は一時ディレクトリの作り物で、ディレクトリを作るのは偽の口だけ
import { after, before, beforeEach, test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import type { Server } from 'node:http'
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AddWorktreeResponse, NewSessionResponse, ReplyingMap, SessionSummary, WorkspacesResponse } from '../shared/types.ts'
import { createApp } from './app.ts'
import { Approvals } from './approvals/approvals.ts'
import type { Git } from './git/diff.ts'
import { createAddWorktree, RealWorktreeAdder } from './git/worktreeAdd.ts'
import { worktreeKey, worktreeParent, Worktrees } from './git/worktrees.ts'
import { localDate } from './rows/aggregate.ts'
import { row } from './rows/aggregate.test.ts'
import { FeedStore } from './rows/store.ts'
import type { ReplyCommand, Runner } from './reply/runner.ts'

/** `git worktree list --porcelain` と、ブランチ・base の有無だけを答える偽物 */
class FakeGit implements Git {
  bare: string | null = null
  trees: string[] = []
  branches = new Set<string>()
  bases = new Set(['main'])
  calls: string[][] = []
  run(_cwd: string, args: string[]): Promise<string> {
    this.calls.push(args)
    if (args[0] === 'worktree' && args[1] === 'list') {
      const blocks = [...(this.bare ? [`worktree ${this.bare}\nbare\n`] : []), ...this.trees.map((t) => `worktree ${t}\nHEAD 0\nbranch refs/heads/x\n`)]
      return Promise.resolve(blocks.join('\n'))
    }
    if (args[0] === 'rev-parse') {
      const ref = String(args.at(-1)).replace(/\^\{commit\}$/, '')
      const hit = ref.startsWith('refs/heads/') ? this.branches.has(ref.slice('refs/heads/'.length)) : this.bases.has(ref)
      return hit ? Promise.resolve('0\n') : Promise.reject(new Error('unknown'))
    }
    return Promise.reject(new Error(`呼ばれない形: ${args.join(' ')}`))
  }
}

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
const fake = new FakeGit()
const adds: { cwd: string; name: string; path: string; base: string }[] = []
let addFails = ''
/** 失敗したあとに残るもの（`worktree`: できている。`branch`: ブランチだけ残る） */
let addLeaves: 'worktree' | 'branch' | '' = ''
const saved = process.env.AGENT_FEED_HOST

const post = (body: unknown, headers: Record<string, string> = { Origin: base }) =>
  fetch(`${base}/api/workspaces`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) })

before(async () => {
  process.env.AGENT_FEED_HOST = 'testmac'
  dir = await realpath(await mkdtemp(join(tmpdir(), 'sai-wt-add-')))
  bare = join(dir, 'app.git')
  await mkdir(join(bare, 'dev-a'), { recursive: true })
  plain = join(dir, 'other')
  await mkdir(plain)
  const feedDir = join(dir, 'feed')
  await mkdir(feedDir)
  const now = new Date()
  const lines = [
    row(new Date(now.getTime() - 60_000), 'A1', { repo: 'dev-a', project: 'me/app', cwd: join(bare, 'dev-a'), host: 'testmac' }),
    row(new Date(now.getTime() - 50_000), 'R1', { repo: 'far', project: 'me/app', cwd: join(bare, 'dev-a'), host: 'far-away' }),
  ]
  await writeFile(join(feedDir, `${localDate(now.toISOString())}.jsonl`), lines.map((l) => JSON.stringify(l)).join('\n') + '\n')
  const app = createApp(
    new FeedStore(feedDir),
    join(dir, 'dist'),
    runner,
    new Approvals(),
    undefined,
    undefined,
    undefined,
    {
      tmux: { run: async () => '' },
      ps: async () => '',
      worktreeAdder: {
        add: async (cwd, name, path, from) => {
          if (addLeaves === 'worktree') {
            await mkdir(path)
            fake.trees.push(path)
          }
          if (addLeaves === 'branch') fake.branches.add(name)
          if (addFails) throw new Error(addFails)
          adds.push({ cwd, name, path, base: from })
          await mkdir(path)
          fake.trees.push(path)
        },
      },
    },
    undefined,
    fake,
  )
  server = createServer((req, res) => void app(req, res))
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const addr = server.address()
  base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`
})

beforeEach(async () => {
  fake.bare = bare
  fake.trees = [join(bare, 'dev-a')]
  fake.branches = new Set()
  fake.bases = new Set(['main'])
  adds.length = 0
  addFails = ''
  addLeaves = ''
  await rm(join(bare, 'new-tree'), { recursive: true, force: true })
})

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
  await rm(dir, { recursive: true, force: true })
  if (saved === undefined) delete process.env.AGENT_FEED_HOST
  else process.env.AGENT_FEED_HOST = saved
})

test('worktreeParent: bare の直下なら bare、全部が同じ親ならその親、分からなければ null（#847）', () => {
  assert.equal(worktreeParent('/r/a.git', ['/r/a.git/x', '/r/a.git/y', '/tmp/stray']), '/r/a.git', 'よそにある worktree は数えない')
  assert.equal(worktreeParent(null, ['/r/app']), '/r', '普通の clone はその隣')
  assert.equal(worktreeParent(null, ['/r/app', '/r/app-b']), '/r')
  assert.equal(worktreeParent('/r/.bare', ['/r/main', '/r/dev']), '/r', 'bare が別の場所でも、worktree が揃っていればその親')
  assert.equal(worktreeParent(null, ['/r/app', '/r/app/.claude/worktrees/x']), null, '親がばらばら')
  assert.equal(worktreeParent('/r/a.git', ['/x/one', '/y/two']), null)
  assert.equal(worktreeParent(null, []), null)
  assert.equal(worktreeParent(null, ['/app']), null, 'ルートの直下には作らない')
})

test('GET /api/workspaces: 置き場の形が分かるリポジトリだけ addable に出す（#847）', async () => {
  const known = (await (await fetch(`${base}/api/workspaces`)).json()) as WorkspacesResponse
  assert.deepEqual(known.addable, ['A1@dev-a'])
})

test('POST /api/workspaces: 名前だけで作り、できた鍵で始められる。パス・ブランチは from の行と名前から（#847）', async () => {
  const res = await post({ from: 'A1@dev-a', name: 'new-tree', cwd: '/etc', path: '/etc/x', base: '--force' })
  assert.equal(res.status, 201)
  const { worktree } = (await res.json()) as AddWorktreeResponse
  const path = join(bare, 'new-tree')
  assert.deepEqual(adds, [{ cwd: join(bare, 'dev-a'), name: 'new-tree', path, base: 'main' }], '置き場は既存の worktree の隣。body の cwd・path・base は見ない')
  assert.deepEqual(worktree, { from: 'A1@dev-a', worktree: worktreeKey(path), cwd: path, repo: 'new-tree', branch: 'new-tree', project: 'me/app' })
  started.length = 0
  const begun = await fetch(`${base}/api/sessions/new`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base }, body: JSON.stringify({ from: worktree.from, worktree: worktree.worktree, text: 'はじめて' }) })
  assert.equal(begun.status, 202)
  assert.equal(((await begun.json()) as NewSessionResponse).cwd, path)
  assert.equal(started[0]?.cmd.cwd, path)
})

test('POST /api/workspaces: 同一オリジンのみ。悪い名前・別のマシン・知らないセッションは git を起こさず断る（#847）', async () => {
  assert.equal((await post({ from: 'A1@dev-a', name: 'new-tree' }, { Origin: 'http://evil.example' })).status, 403)
  for (const name of ['..', '../x', 'a/b', '-b', '--force', join(dir, 'x'), '', 'HEAD']) assert.equal((await post({ from: 'A1@dev-a', name })).status, 400, name)
  assert.equal((await post({ from: 'A1@dev-a', name: 7 })).status, 400)
  assert.equal((await post({ from: 'R1@far', name: 'new-tree' })).status, 400, '別のマシン')
  assert.equal((await post({ from: 'nobody@x', name: 'new-tree' })).status, 404)
  assert.deepEqual(adds, [])
})

test('POST /api/workspaces: 既にある名前（ディレクトリ・worktree・ブランチ）は 409（#847）', async () => {
  assert.equal((await post({ from: 'A1@dev-a', name: 'dev-a' })).status, 409, '一覧にある')
  assert.equal((await post({ from: 'A1@dev-a', name: 'DEV-A' })).status, 409, '大文字小文字だけ違う')
  await mkdir(join(dir, 'elsewhere', 'stray'), { recursive: true })
  fake.trees.push(join(dir, 'elsewhere', 'stray'))
  assert.equal((await post({ from: 'A1@dev-a', name: 'stray' })).status, 409, 'よその場所の worktree とも重ねない')
  await mkdir(join(bare, 'new-tree'))
  assert.equal((await post({ from: 'A1@dev-a', name: 'new-tree' })).status, 409, 'ディレクトリがある')
  await rm(join(bare, 'new-tree'), { recursive: true })
  fake.branches.add('new-tree')
  assert.equal((await post({ from: 'A1@dev-a', name: 'new-tree' })).status, 409, 'ブランチがある')
  assert.deepEqual(adds, [])
})

test('POST /api/workspaces: 形が分からない・base が無いときは作らず、失敗は理由を返す（#847）', async () => {
  await mkdir(join(plain, 'deep'), { recursive: true })
  fake.bare = null
  fake.trees = [join(bare, 'dev-a'), join(plain, 'deep')]
  assert.equal((await post({ from: 'A1@dev-a', name: 'new-tree' })).status, 400, '形が分からない')
  fake.bare = bare
  fake.trees = [join(bare, 'dev-a')]
  fake.bases = new Set()
  assert.equal((await post({ from: 'A1@dev-a', name: 'new-tree' })).status, 409, 'base が無い')
  fake.bases = new Set(['main'])
  addFails = 'fatal: 作り物の失敗'
  const failed = await post({ from: 'A1@dev-a', name: 'new-tree' })
  assert.equal(failed.status, 500)
  assert.match(((await failed.json()) as { error: string }).error, /作り物の失敗/)
})

test('POST /api/workspaces: git が非 0 でも worktree ができていれば使える。ブランチだけ残れば、そう伝える（#847 のレビュー）', async () => {
  addFails = 'hook failed'
  addLeaves = 'worktree'
  const made = await post({ from: 'A1@dev-a', name: 'new-tree' })
  assert.equal(made.status, 201, 'post-checkout フックの失敗など')
  assert.equal(((await made.json()) as AddWorktreeResponse).worktree.cwd, join(bare, 'new-tree'))
  const places = (await (await fetch(`${base}/api/workspaces`)).json()) as WorkspacesResponse
  assert.ok(places.siblings.some((w) => w.repo === 'new-tree'), '覚えた一覧も捨ててある')
  await rm(join(bare, 'new-tree'), { recursive: true })
  fake.trees = [join(bare, 'dev-a')]
  addLeaves = 'branch'
  const left = await post({ from: 'A1@dev-a', name: 'new-tree' })
  assert.equal(left.status, 500)
  assert.match(((await left.json()) as { error: string }).error, /ブランチ new-tree が残っています/)
})

test('createAddWorktree: 同じ名前が同時に来たら 1 つだけ作る（#847）', async () => {
  let release = () => {}
  const held = new Promise<void>((resolve) => (release = resolve))
  let count = 0
  const add = createAddWorktree({
    git: fake,
    worktrees: new Worktrees(fake),
    selfHost: () => 'testmac',
    adder: {
      add: async () => {
        count++
        await held
      },
    },
  })
  const from = { id: 'A1@dev-a', cwd: join(bare, 'dev-a'), host: 'testmac', project: 'me/app' } as SessionSummary
  const both = [add(from, 'same'), add(from, 'same')]
  // どちらかが断られて返る（もう片方は偽の口で待っている）
  assert.equal((await Promise.race(both)).status, 409)
  release()
  assert.deepEqual((await Promise.all(both)).map((r) => r.status).sort(), [201, 409])
  assert.equal(count, 1)
})

test('RealWorktreeAdder: 起こすのは worktree add の 1 形だけ。失敗は stderr を返す（#847）', async () => {
  const bin = join(dir, 'fake-git')
  const log = join(dir, 'fake-git.log')
  await writeFile(bin, `#!/bin/sh\nfor a in "$@"; do printf '%s\\n' "$a" >> ${JSON.stringify(log)}; done\ncase "$*" in *broken*) echo 'fatal: だめ' >&2; exit 128;; esac\n`)
  await chmod(bin, 0o755)
  const adder = new RealWorktreeAdder(bin)
  await adder.add('/w/cwd', 'tree', '/w/tree', 'origin/main')
  assert.deepEqual((await readFile(log, 'utf8')).trim().split('\n'), ['-C', '/w/cwd', '--no-pager', 'worktree', 'add', '--quiet', '--no-track', '-b', 'tree', '/w/tree', 'origin/main'])
  await assert.rejects(adder.add('/w/cwd', 'broken', '/w/broken', 'main'), /fatal: だめ/)
})

test('RealWorktreeAdder: フックが残した子が stderr を持ったままでも、git が終われば返る（#847 のレビュー）', async () => {
  const bin = join(dir, 'fake-git-hold')
  await writeFile(bin, '#!/bin/sh\nsleep 5 &\nexit 0\n')
  await chmod(bin, 0o755)
  const at = Date.now()
  await new RealWorktreeAdder(bin).add('/w/cwd', 'tree', '/w/tree', 'main')
  assert.ok(Date.now() - at < 3000, '子の終わりを待たない')
})
