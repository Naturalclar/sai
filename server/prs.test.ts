// GET /api/prs と /api/prs/<owner>/<repo>/<番号>（#524）。PR を読む口（PrBrowser）は差し替えるので、
// テストはネットワークにも gh にも触らない。並べるリポジトリが「記録で知っているもの」だけになること、
// 知らないリポジトリの名前を渡されても読みに行かないことを見る。
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import type { Server } from 'node:http'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { PrDetailResponse, PrSummary, PrsResponse } from '../shared/types.ts'
import { createApp } from './app.ts'
import { FeedStore } from './rows/store.ts'
import { localDate } from './rows/aggregate.ts'
import { row } from './rows/aggregate.test.ts'
import { GhPrs } from './git/prs.ts'
import type { GhRun, PrBrowser, PrView } from './git/prs.ts'

const summary = (number: number, extra: Partial<PrSummary> = {}): PrSummary => ({
  number,
  title: `PR ${number}`,
  author: 'someone',
  head: 'feat',
  base: 'main',
  draft: false,
  updated_at: '2026-09-30T00:00:00Z',
  url: `https://github.com/o/known/pull/${number}`,
  additions: 1,
  deletions: 1,
  changed_files: 1,
  review_decision: '',
  checks: '',
  requested: false,
  ...extra,
})

const PATCH = ['diff --git a/a.ts b/a.ts', '--- a/a.ts', '+++ b/a.ts', '@@ -1 +1,2 @@', '-old', '+new', '+more', ''].join('\n')

/** 呼ばれたリポジトリを覚え、決めた答えを返す */
class FakePrs implements PrBrowser {
  readonly available = true
  listed: string[] = []
  viewed: [string, number][] = []
  patch: string | null = PATCH
  async list(repo: string) {
    this.listed.push(repo)
    return repo === 'o/broken' ? null : [summary(1)]
  }
  async view(repo: string, number: number): Promise<PrView | null> {
    this.viewed.push([repo, number])
    return { pr: { ...summary(number), body: '本文', state: 'OPEN', head_sha: 'abc' }, patch: this.patch }
  }
}

let dir: string
let server: Server
let base: string
const prs = new FakePrs()

before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'sai-prs-'))
  const feedDir = join(dir, 'feed')
  await mkdir(feedDir)
  const now = new Date()
  // GitHub のリポジトリ 2 つ（1 つは gh が読めない）と、GitHub 以外のリポジトリ 1 つ
  const lines = [
    row(now, 'S1', { repo: 'known', cwd: '/w/known', project: 'o/known', remote: 'https://github.com/o/known' }),
    row(now, 'S2', { repo: 'broken', cwd: '/w/broken', project: 'o/broken', remote: 'https://github.com/o/broken' }),
    row(now, 'S3', { repo: 'lab', cwd: '/w/lab', project: 'g/lab', remote: 'https://gitlab.com/g/lab' }),
  ].map((r) => JSON.stringify(r))
  await writeFile(join(feedDir, `${localDate(now.toISOString())}.jsonl`), `${lines.join('\n')}\n`)
  const store = new FeedStore(feedDir)
  const app = createApp(store, join(dir, 'dist'), undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, prs)
  server = createServer((req, res) => void app(req, res))
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const addr = server.address()
  base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`
})

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
  await rm(dir, { recursive: true, force: true })
})

test('一覧: 記録で知っている GitHub のリポジトリだけを読み、読めないものは error で返す', async () => {
  prs.listed = []
  const res = await fetch(`${base}/api/prs`)
  assert.equal(res.status, 200)
  const body = (await res.json()) as PrsResponse
  assert.equal(body.available, true)
  assert.deepEqual(prs.listed.sort(), ['o/broken', 'o/known'])
  const known = body.repos.find((r) => r.repo === 'o/known')
  assert.deepEqual(known?.prs.map((p) => p.number), [1])
  const broken = body.repos.find((r) => r.repo === 'o/broken')
  assert.equal(broken?.prs.length, 0)
  assert.ok(broken?.error)
  assert.ok(body.rev)
})

test('1 本: 中身と差分を返す。見出しは本文から数える', async () => {
  prs.patch = PATCH
  const res = await fetch(`${base}/api/prs/o/known/7`)
  assert.equal(res.status, 200)
  const body = (await res.json()) as PrDetailResponse
  assert.equal(body.repo, 'o/known')
  assert.equal(body.pr.number, 7)
  assert.equal(body.pr.body, '本文')
  assert.deepEqual(body.diff.files, [{ path: 'a.ts', status: 'modified', added: 2, removed: 1 }])
  assert.equal(body.diff.truncated, false)
  assert.equal(body.diff_error, undefined)
})

test('1 本: URL の大文字小文字が違っても、知っている名前で読みに行く', async () => {
  prs.viewed = []
  const res = await fetch(`${base}/api/prs/O/KNOWN/7`)
  assert.equal(res.status, 200)
  assert.deepEqual(prs.viewed, [['o/known', 7]])
})

test('1 本: 差分を読めなければ中身は返し、理由を添える', async () => {
  prs.patch = null
  const res = await fetch(`${base}/api/prs/o/known/7`)
  const body = (await res.json()) as PrDetailResponse
  assert.equal(body.pr.number, 7)
  assert.equal(body.diff.files.length, 0)
  assert.ok(body.diff_error)
  prs.patch = PATCH
})

test('1 本: 知らないリポジトリ・GitHub 以外・番号でないものは読みに行かずに 404', async () => {
  prs.viewed = []
  for (const p of ['/api/prs/someone/else/1', '/api/prs/g/lab/1', '/api/prs/o/known/abc', '/api/prs/o/known/0', '/api/prs/o/known/1/extra', '/api/prs/o']) {
    const res = await fetch(`${base}${p}`)
    assert.equal(res.status, 404, p)
  }
  assert.deepEqual(prs.viewed, [])
})

test('書き込みは受けない', async () => {
  const res = await fetch(`${base}/api/prs`, { method: 'POST' })
  assert.equal(res.status, 405)
})

test('GhPrs: 組み立てる gh の引数は読むサブコマンドだけ。頼まれているものを先に並べる', async () => {
  const calls: string[][] = []
  const run: GhRun = async (args) => {
    calls.push(args)
    if (args.includes('--search')) return '[{"number":2}]'
    if (args[1] === 'list') return JSON.stringify([
      { number: 1, updatedAt: '2026-09-30T00:00:00Z' },
      { number: 2, updatedAt: '2026-09-01T00:00:00Z' },
    ])
    if (args[1] === 'view') return JSON.stringify({ number: 2, body: 'b', state: 'OPEN', headRefOid: 'sha' })
    if (args[1] === 'diff') return PATCH
    return null
  }
  const gh = new GhPrs(run)
  const list = await gh.list('o/r')
  assert.deepEqual(list?.map((p) => [p.number, p.requested]), [[2, true], [1, false]])
  const view = await gh.view('o/r', 2)
  assert.equal(view?.pr.requested, true)
  assert.equal(view?.pr.head_sha, 'sha')
  assert.equal(view?.patch, PATCH)
  // 呼んだのは pr list / pr view / pr diff だけで、どれも --repo で名指し
  for (const args of calls) {
    assert.equal(args[0], 'pr')
    assert.ok(['list', 'view', 'diff'].includes(args[1] ?? ''), args.join(' '))
    assert.equal(args[args.indexOf('--repo') + 1], 'o/r')
  }
  // 形の悪い名前・番号は gh を起こさない
  const called = calls.length
  assert.equal(await gh.list('-x/y'), null)
  assert.equal(await gh.view('o/r', 0), null)
  assert.equal(calls.length, called)
})

test('GhPrs: 一覧は覚えておき、fresh のときだけ読み直す。読めなかったことも覚える', async () => {
  let n = 0
  const gh = new GhPrs(async (args) => {
    if (args[1] === 'list' && !args.includes('--search')) n++
    return args.includes('--search') ? '[]' : null
  })
  assert.equal(await gh.list('o/r'), null)
  assert.equal(await gh.list('o/r'), null)
  assert.equal(n, 1)
  await gh.list('o/r', true)
  assert.equal(n, 2)
})
