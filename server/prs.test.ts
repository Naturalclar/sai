// GET /api/prs と /api/prs/<owner>/<repo>/<番号>（#524）。PR を読む口（PrBrowser）は差し替えるので、
// テストはネットワークにも gh にも触らない。並べるリポジトリが「記録で知っているもの」だけになること、
// 知らないリポジトリの名前を渡されても読みに行かないことを見る。
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import type { Server } from 'node:http'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { PrDetailResponse, PrReviewRequest, PrReviewResponse, PrSummary, PrsResponse, ReplyError } from '../shared/types.ts'
import type { GithubReview } from '../shared/prReview.ts'
import type { PrCommentList } from '../shared/prComments.ts'
import { createApp } from './app.ts'
import { FeedStore } from './rows/store.ts'
import { localDate } from './rows/aggregate.ts'
import { row } from './rows/aggregate.test.ts'
import { GhPrs } from './git/prs.ts'
import type { GhRun, GhSend, PrBrowser, PrView } from './git/prs.ts'

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

const SHA = 'a'.repeat(40)
const PATCH = ['diff --git a/a.ts b/a.ts', '--- a/a.ts', '+++ b/a.ts', '@@ -1 +1,2 @@', '-old', '+new', '+more', ''].join('\n')

/** 呼ばれたリポジトリを覚え、決めた答えを返す */
class FakePrs implements PrBrowser {
  readonly available = true
  listed: string[] = []
  viewed: [string, number][] = []
  patch: string | null = PATCH
  headSha = SHA
  author = 'someone'
  login: string | null = 'me'
  posted: [string, number, GithubReview][] = []
  postResult: { ok: true; url: string } | { ok: false; error: string } = { ok: true, url: 'https://github.com/o/known/pull/7#pullrequestreview-1' }
  /** コメント（#600）。null は「読めなかった」、throw もさせられる */
  commentList: PrCommentList | null | Error = { comments: [], omitted: 0 }
  commented: [string, number][] = []
  async comments(repo: string, number: number) {
    this.commented.push([repo, number])
    if (this.commentList instanceof Error) throw this.commentList
    return this.commentList
  }
  async viewer() {
    return this.login
  }
  async postReview(repo: string, number: number, review: GithubReview) {
    this.posted.push([repo, number, review])
    return this.postResult
  }
  async list(repo: string) {
    this.listed.push(repo)
    return repo === 'o/broken' ? null : [summary(1)]
  }
  async view(repo: string, number: number): Promise<PrView | null> {
    this.viewed.push([repo, number])
    return { pr: { ...summary(number, { author: this.author }), body: '本文', state: 'OPEN', head_sha: this.headSha, cross_repo: false }, patch: this.patch }
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

test('1 本: 会話のコメントとレビューを載せる。落とした数があれば添える（#600）', async () => {
  const one = { id: 'c1', kind: 'comment' as const, author: 'alice', at: '2026-10-01T00:00:00Z', body: '見ました', url: 'https://github.com/o/known/pull/7#issuecomment-1' }
  prs.commentList = { comments: [one], omitted: 2 }
  prs.commented = []
  const body = (await (await fetch(`${base}/api/prs/O/Known/7`)).json()) as PrDetailResponse
  assert.deepEqual(body.comments, [one])
  assert.equal(body.comments_omitted, 2)
  assert.equal(body.comments_error, undefined)
  assert.deepEqual(prs.commented, [['o/known', 7]], '知っている名前で読みに行く')
  prs.commentList = { comments: [], omitted: 0 }
  const none = (await (await fetch(`${base}/api/prs/o/known/7`)).json()) as PrDetailResponse
  assert.deepEqual(none.comments, [])
  assert.equal(none.comments_omitted, undefined)
})

test('1 本: コメントだけ読めなくても、本文と差分は返して理由を添える（#600）', async () => {
  for (const broken of [null, new Error('gh が落ちた')]) {
    prs.commentList = broken
    prs.patch = PATCH
    const res = await fetch(`${base}/api/prs/o/known/7`)
    assert.equal(res.status, 200)
    const body = (await res.json()) as PrDetailResponse
    assert.equal(body.pr.body, '本文')
    assert.equal(body.diff.files.length, 1)
    assert.equal(body.comments, undefined)
    assert.ok(body.comments_error)
  }
  prs.commentList = { comments: [], omitted: 0 }
})

test('1 本: 知らないリポジトリ・GitHub 以外・番号でないものは読みに行かずに 404', async () => {
  prs.viewed = []
  for (const p of ['/api/prs/someone/else/1', '/api/prs/g/lab/1', '/api/prs/o/known/abc', '/api/prs/o/known/0', '/api/prs/o/known/1/extra', '/api/prs/o']) {
    const res = await fetch(`${base}${p}`)
    assert.equal(res.status, 404, p)
  }
  assert.deepEqual(prs.viewed, [])
})

test('書き込みはレビューの口だけ。ほかの POST・レビューの口の GET は受けない', async () => {
  assert.equal((await fetch(`${base}/api/prs`, { method: 'POST' })).status, 405)
  assert.equal((await fetch(`${base}/api/prs/o/known/7`, { method: 'POST' })).status, 405)
  assert.equal((await fetch(`${base}/api/prs/o/known/7/review`)).status, 405)
})

// --- GitHub へのレビューの投稿（#526） ---

const review = (extra: Partial<PrReviewRequest> = {}): PrReviewRequest => ({
  event: 'COMMENT',
  body: '全体',
  commit_id: SHA,
  comments: [
    { path: 'a.ts', side: 'new', line: 2, code: 'more', body: 'ここ' },
    { path: 'a.ts', side: 'old', line: 1, code: 'old', body: '消した理由は？' },
  ],
  ...extra,
})

const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(`${base}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) })

test('投稿: 1 本の中身に投稿の材料（ログインしている人・自分の PR か）が載る。引けなければ載らない', async () => {
  prs.author = 'Me'
  let body = (await (await fetch(`${base}/api/prs/o/known/7`)).json()) as PrDetailResponse
  assert.deepEqual(body.review, { viewer: 'me', own: true })
  prs.author = 'someone'
  body = (await (await fetch(`${base}/api/prs/o/known/7`)).json()) as PrDetailResponse
  assert.deepEqual(body.review, { viewer: 'me', own: false })
  prs.login = null
  body = (await (await fetch(`${base}/api/prs/o/known/7`)).json()) as PrDetailResponse
  assert.equal(body.review, undefined)
  prs.login = 'me'
})

test('投稿: 行の位置はサーバがいまの差分から組み立て、GitHub の形にして 1 回だけ送る。reply.log に 1 行残す', async () => {
  prs.posted = []
  const res = await post('/api/prs/O/Known/7/review', review())
  assert.equal(res.status, 200)
  const body = (await res.json()) as PrReviewResponse
  assert.equal(body.url, 'https://github.com/o/known/pull/7#pullrequestreview-1')
  assert.deepEqual(prs.posted, [
    [
      'o/known',
      7,
      {
        commit_id: SHA,
        event: 'COMMENT',
        body: '全体',
        comments: [
          { path: 'a.ts', line: 2, side: 'RIGHT', body: 'ここ' },
          { path: 'a.ts', line: 1, side: 'LEFT', body: '消した理由は？' },
        ],
      },
    ],
  ])
  const log = await readFile(join(dir, 'feed', 'reply.log'), 'utf8')
  assert.match(log, /GitHub へレビュー o\/known#7 COMMENT 行コメント 2 件 commit a{12} \(me\) → https:\/\/github\.com/)
})

test('投稿: 別オリジン・知らないリポジトリは送らない', async () => {
  prs.posted = []
  assert.equal((await post('/api/prs/o/known/7/review', review(), { Origin: 'http://evil.example' })).status, 403)
  assert.equal((await post('/api/prs/o/known/7/review', review(), { 'Sec-Fetch-Site': 'cross-site' })).status, 403)
  assert.equal((await post('/api/prs/someone/else/7/review', review())).status, 404)
  assert.equal((await post('/api/prs/g/lab/7/review', review())).status, 404)
  assert.deepEqual(prs.posted, [])
})

test('投稿: head が進んでいれば 409（head_moved）で送らない', async () => {
  prs.posted = []
  prs.headSha = 'b'.repeat(40)
  const res = await post('/api/prs/o/known/7/review', review())
  assert.equal(res.status, 409)
  assert.equal(((await res.json()) as ReplyError).code, 'head_moved')
  prs.headSha = SHA
  assert.deepEqual(prs.posted, [])
})

test('投稿: 行が変わった・見当たらないコメントがあれば 409（lines_moved）で、ほかのコメントも送らない', async () => {
  prs.posted = []
  for (const bad of [
    { path: 'a.ts', side: 'new' as const, line: 2, code: 'changed', body: 'x' },
    { path: 'a.ts', side: 'new' as const, line: 9, code: 'more', body: 'x' },
    { path: 'b.ts', side: 'new' as const, line: 2, code: 'more', body: 'x' },
  ]) {
    const res = await post('/api/prs/o/known/7/review', review({ comments: [review().comments[0]!, bad] }))
    assert.equal(res.status, 409)
    const body = (await res.json()) as ReplyError
    assert.equal(body.code, 'lines_moved')
    assert.match(body.error, new RegExp(`${bad.path}:${bad.line}`))
  }
  assert.deepEqual(prs.posted, [])
})

test('投稿: 自分の PR には Comment だけ。ログインしていない・形の悪い要求は送らない', async () => {
  prs.posted = []
  prs.author = 'ME'
  assert.equal((await post('/api/prs/o/known/7/review', review({ event: 'APPROVE' }))).status, 400)
  assert.equal((await post('/api/prs/o/known/7/review', review({ event: 'REQUEST_CHANGES' }))).status, 400)
  prs.author = 'someone'
  prs.login = null
  assert.equal((await post('/api/prs/o/known/7/review', review())).status, 503)
  prs.login = 'me'
  for (const bad of [
    review({ event: 'MERGE' as never }),
    review({ commit_id: 'abc' }),
    review({ event: 'REQUEST_CHANGES', body: ' ' }),
    review({ body: '', comments: [] }),
    review({ comments: [{ path: 'a.ts', side: 'new', line: 2, code: 'more', body: ' ' }] }),
  ]) {
    assert.equal((await post('/api/prs/o/known/7/review', bad)).status, 400, JSON.stringify(bad))
  }
  assert.deepEqual(prs.posted, [])
})

test('投稿: GitHub が断ったら 502 で理由を返し、reply.log にも残す', async () => {
  prs.postResult = { ok: false, error: 'Validation Failed: pull_request_review_thread.line must be part of the diff' }
  const res = await post('/api/prs/o/known/7/review', review())
  assert.equal(res.status, 502)
  assert.match(((await res.json()) as ReplyError).error, /must be part of the diff/)
  const log = await readFile(join(dir, 'feed', 'reply.log'), 'utf8')
  assert.match(log, /失敗: Validation Failed/)
  prs.postResult = { ok: true, url: '' }
})

test('GhPrs: 投稿は gh api -X POST repos/<repo>/pulls/<番号>/reviews --input - の 1 形で、中身は stdin に渡す', async () => {
  const sent: [string[], string][] = []
  const send: GhSend = async (args, input) => {
    sent.push([args, input])
    return { code: 0, stdout: '{"html_url":"https://github.com/o/r/pull/2#pullrequestreview-9"}', stderr: '' }
  }
  const gh = new GhPrs(async () => null, 60_000, send)
  const r: GithubReview = { commit_id: SHA, event: 'COMMENT', comments: [{ path: 'a.ts', line: 2, side: 'RIGHT', body: 'x' }] }
  assert.deepEqual(await gh.postReview('o/r', 2, r), { ok: true, url: 'https://github.com/o/r/pull/2#pullrequestreview-9' })
  assert.deepEqual(sent, [[['api', '-X', 'POST', 'repos/o/r/pulls/2/reviews', '--input', '-'], JSON.stringify(r)]])
  // 形の悪い宛先は gh を起こさない
  assert.equal((await gh.postReview('-x/y', 2, r)).ok, false)
  assert.equal((await gh.postReview('o/r', 0, r)).ok, false)
  assert.equal(sent.length, 1)
  // 失敗は GitHub の応答から理由を読む
  const failing = new GhPrs(async () => null, 60_000, async () => ({ code: 1, stdout: '{"message":"Unprocessable Entity","errors":["Review Can not approve your own pull request"]}', stderr: 'gh: Unprocessable Entity (HTTP 422)' }))
  assert.deepEqual(await failing.postReview('o/r', 2, r), { ok: false, error: 'Unprocessable Entity: Review Can not approve your own pull request' })
})

test('GhPrs: ログインしている人は gh api user で引いて覚える。引けなければ null', async () => {
  const calls: string[][] = []
  const gh = new GhPrs(async (args) => {
    calls.push(args)
    return 'someone\n'
  })
  assert.equal(await gh.viewer(), 'someone')
  assert.equal(await gh.viewer(), 'someone')
  assert.deepEqual(calls, [['api', 'user', '--jq', '.login']])
  const out = new GhPrs(async () => null)
  assert.equal(await out.viewer(), null)
  const odd = new GhPrs(async () => 'not a login')
  assert.equal(await odd.viewer(), null)
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
    if (args[1] === 'view') return JSON.stringify({ number: 2, body: 'b', state: 'OPEN', headRefOid: 'sha', isCrossRepository: true })
    if (args[1] === 'diff') return PATCH
    return null
  }
  const gh = new GhPrs(run)
  const list = await gh.list('o/r')
  assert.deepEqual(list?.map((p) => [p.number, p.requested]), [[2, true], [1, false]])
  const view = await gh.view('o/r', 2)
  assert.equal(view?.pr.requested, true)
  assert.equal(view?.pr.head_sha, 'sha')
  // フォークから出た PR か（#525 の書いたセッションを探さない）
  assert.equal(view?.pr.cross_repo, true)
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

test('GhPrs: コメントは gh pr view --json comments,reviews の 1 形で読む。読めなければ null、形の悪い宛先は gh を起こさない（#600）', async () => {
  const calls: string[][] = []
  let out: string | null = JSON.stringify({
    comments: [{ id: 'c1', author: { login: 'alice' }, body: '見ました', createdAt: '2026-10-01T00:00:00Z', isMinimized: false, url: 'https://github.com/o/r/pull/2#issuecomment-1' }],
    reviews: [{ id: 'r1', author: { login: 'bob' }, body: '', submittedAt: '2026-10-01T01:00:00Z', state: 'APPROVED' }],
  })
  const gh = new GhPrs(async (args) => {
    calls.push(args)
    return out
  })
  const list = await gh.comments('o/r', 2)
  assert.deepEqual(list?.comments.map((c) => [c.kind, c.author, c.state]), [['comment', 'alice', undefined], ['review', 'bob', 'APPROVED']])
  assert.deepEqual(calls, [['pr', 'view', '2', '--repo', 'o/r', '--json', 'comments,reviews']])
  out = null
  assert.equal(await gh.comments('o/r', 2), null)
  out = 'not json'
  assert.equal(await gh.comments('o/r', 2), null)
  const called = calls.length
  assert.equal(await gh.comments('-x/y', 2), null)
  assert.equal(await gh.comments('o/r', 0), null)
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
