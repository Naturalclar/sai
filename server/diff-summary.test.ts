// GET /api/sessions/<id>/diff?summary=1（#211）。本物の一時リポジトリを cwd にして、
// 入力欄の差分ボタンが出す行数と PR 番号がそのまま返ってくることを見る。
// PR を引く口（PrLookup）は差し替えるので、テストはネットワークにも gh にも触らない。
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import type { Server } from 'node:http'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import type { DiffPr, SessionDiffSummaryResponse } from '../shared/types.ts'
import { createApp } from './app.ts'
import { FeedStore } from './rows/store.ts'
import { localDate } from './rows/aggregate.ts'
import { row } from './rows/aggregate.test.ts'
import type { PrLookup } from './git/pr.ts'

const run = promisify(execFile)
const git = async (cwd: string, ...args: string[]) => {
  await run('git', ['-C', cwd, '-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args])
}

/** 呼ばれた (cwd, branch) を覚え、決めた PR を返す */
class FakePr implements PrLookup {
  calls: [string, string][] = []
  pr: DiffPr | null = null
  async find(cwd: string, branch: string) {
    this.calls.push([cwd, branch])
    return this.pr
  }
}

let dir: string
let repo: string
let server: Server
let base: string
const pr = new FakePr()

const get = (path: string) => fetch(`${base}${path}`)

before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'sai-sum-'))
  const feedDir = join(dir, 'feed')
  repo = join(dir, 'repo')
  await mkdir(feedDir)
  await mkdir(repo)

  await git(repo, 'init', '-q', '-b', 'main')
  await writeFile(join(repo, 'a.ts'), 'one\ntwo\nthree\n')
  await git(repo, 'add', '.')
  await git(repo, 'commit', '-q', '-m', 'first')
  await git(repo, 'checkout', '-q', '-b', 'feat/x')
  await writeFile(join(repo, 'a.ts'), 'one\nTWO\nthree\n')
  await writeFile(join(repo, 'b.ts'), 'new\n')
  await git(repo, 'add', '.')
  await git(repo, 'commit', '-q', '-m', 'work')
  await writeFile(join(repo, 'untracked.ts'), 'not added\n')

  // その cwd で回っていることになっているセッションを1行だけ置く
  const now = new Date()
  const line = JSON.stringify(row(now, 'S1', { repo: 'repo', cwd: repo, branch: 'feat/x' }))
  await writeFile(join(feedDir, `${localDate(now.toISOString())}.jsonl`), `${line}\n`)

  const store = new FeedStore(feedDir)
  const app = createApp(store, join(dir, 'dist'), undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, pr)
  server = createServer((req, res) => void app(req, res))
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const addr = server.address()
  base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`
})

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
  await rm(dir, { recursive: true, force: true })
})

test('summary=1: 行数を返し、PR は引いた口の答えをそのまま載せる', async () => {
  pr.pr = { number: 211, url: 'https://github.com/o/r/pull/211', state: 'OPEN', draft: false }
  pr.calls.length = 0

  const res = await get('/api/sessions/S1%40repo/diff?summary=1')
  assert.equal(res.status, 200)
  const s = (await res.json()) as SessionDiffSummaryResponse

  assert.equal(s.id, 'S1@repo')
  assert.equal(s.base, 'main', 'origin が無いのでローカルの main に落ちる')
  assert.equal(s.head, 'feat/x')
  assert.deepEqual(s.branch, { files: 2, added: 2, removed: 1 })
  assert.deepEqual(s.working, { files: 0, added: 0, removed: 0 }, '未コミットの書き換えは無い')
  assert.equal(s.files, 2)
  assert.equal(s.untracked, 1, '追跡外は数だけ')
  assert.deepEqual(s.pr, { number: 211, url: 'https://github.com/o/r/pull/211', state: 'OPEN', draft: false })

  assert.deepEqual(pr.calls, [[repo, 'feat/x']], 'cwd はセッションの行から、ブランチは git から')
  assert.ok(!('cwd' in s), '要約は cwd を返さない（ボタンに要らない）')
})

test('summary=1: PR が無ければ pr のキーごと付けない', async () => {
  pr.pr = null
  const s = (await (await get('/api/sessions/S1%40repo/diff?summary=1')).json()) as SessionDiffSummaryResponse
  assert.equal(s.pr, undefined)
  assert.equal(s.files, 2, 'PR が引けなくても差分そのものは返る')
})

test('summary=1: 知らないセッションは 404、POST は 405（読むだけ）', async () => {
  assert.equal((await get('/api/sessions/nope%40r/diff?summary=1')).status, 404)
  assert.equal((await fetch(`${base}/api/sessions/S1%40repo/diff?summary=1`, { method: 'POST' })).status, 405)
})

test('summary=1 でなければ、今までどおり本文（patch）付きで返る', async () => {
  const full = (await (await get('/api/sessions/S1%40repo/diff')).json()) as { branch: { patch: string }; cwd: string }
  assert.match(full.branch.patch, /\+TWO/, '素の /diff は patch を作る')
  assert.equal(full.cwd, repo)
})
