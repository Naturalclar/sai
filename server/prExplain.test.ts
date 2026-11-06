// PR の解説（#881。`/brief-pr`）。回す口（POST …/explain）・状態（PR の GET の `explain`）・HTML を配る口（GET /api/pr-explain/<鍵>）。
// PR を読む口と子プロセスは差し替えるので、gh にも claude にも触らない。一時フォルダも作り物（本物の `os.tmpdir()` は見ない）。
// 中身・名前は作り物だけ。
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createServer, request } from 'node:http'
import type { Server } from 'node:http'
import { appendFile, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { FeedRow, PrDetailResponse, PrExplainResponse, PrSummary, Replying, ReplyFailure } from '../shared/types.ts'
import { createApp } from './app.ts'
import { Authenticator } from './auth.ts'
import { FeedStore } from './rows/store.ts'
import { localDate } from './rows/aggregate.ts'
import { row } from './rows/aggregate.test.ts'
import type { PrBrowser, PrView } from './git/prs.ts'
import type { ReplyCommand, Runner } from './reply/runner.ts'
import { briefHtmlIn, explainView } from './git/prExplains.ts'

const summary = (number: number): PrSummary => ({
  number,
  title: `作り物の題名 ${number}`,
  author: 'someone',
  head: 'feat',
  base: 'main',
  draft: false,
  updated_at: '2026-11-01T00:00:00Z',
  url: `https://github.com/o/known/pull/${number}`,
  additions: 1,
  deletions: 1,
  changed_files: 1,
  review_decision: '',
  checks: '',
  requested: false,
})

class FakePrs implements PrBrowser {
  readonly available = true
  headSha = 'a'.repeat(40)
  posted = 0
  async list() {
    return [summary(1)]
  }
  async view(_repo: string, number: number): Promise<PrView | null> {
    return { pr: { ...summary(number), body: '作り物の本文', state: 'OPEN', head_sha: this.headSha, cross_repo: false }, patch: '' }
  }
  async comments() {
    return { comments: [], omitted: 0 }
  }
  async lineComments() {
    return { comments: [], omitted: 0 }
  }
  async viewer() {
    return 'me'
  }
  async postReview(): Promise<{ ok: true; url: string }> {
    this.posted++
    return { ok: true, url: '' }
  }
}

class FakeRunner implements Runner {
  started: { id: string; cmd: ReplyCommand }[] = []
  busy = new Map<string, Replying>()
  running(id: string) {
    return this.busy.has(id)
  }
  snapshot() {
    return Object.fromEntries(this.busy)
  }
  async start(id: string, cmd: ReplyCommand, _onExit?: (failure: ReplyFailure | null) => void | Promise<void>) {
    this.started.push({ id, cmd })
    this.busy.set(id, { since: new Date().toISOString(), text: cmd.text })
  }
}

let dir: string
let feedDir: string
let tmpRoot: string
let repoDir: string
let base: string
let server: Server
const prs = new FakePrs()
const runner = new FakeRunner()
const TAILNET = { 'Tailscale-User-Login': 'me@example.com', 'Tailscale-User-Name': 'Me', 'X-Forwarded-For': '100.64.0.1', 'X-Forwarded-Proto': 'https' }

before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'sai-pr-explain-'))
  feedDir = join(dir, 'feed')
  tmpRoot = join(dir, 'tmp')
  repoDir = join(dir, 'known')
  await mkdir(feedDir)
  await mkdir(tmpRoot)
  await mkdir(repoDir)
  // 回す場所は git の作業ツリーの中だけ（#319 と同じ検査を通す）。作り物の空のリポジトリ
  execFileSync('git', ['init', '-q', '-b', 'main', repoDir])
  const now = new Date()
  await writeFile(join(feedDir, `${localDate(now.toISOString())}.jsonl`), `${JSON.stringify(row(now, 'S1', { repo: 'known', cwd: repoDir, project: 'o/known', remote: 'https://github.com/o/known' }))}\n`)
  const auth = new Authenticator(async (addr) => (addr === '100.64.0.1' ? { login: 'me@example.com', tagged: false, node: 'laptop', caps: {} } : addr === '100.64.0.2' ? { login: '', tagged: true, node: 'tagged-box', caps: {} } : null), 30_000)
  const terminal = { tmux: { run: async () => { throw new Error('unused') } }, ps: async () => '', briefTmp: tmpRoot }
  const app = createApp(new FeedStore(feedDir), join(dir, 'dist'), runner, undefined, undefined, undefined, auth, terminal, undefined, undefined, undefined, undefined, undefined, undefined, prs)
  server = createServer((req, res) => void app(req, res))
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const addr = server.address()
  base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`
})

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
  await rm(dir, { recursive: true, force: true })
})

/** Host を書き換えて GET する（fetch は Host を変えられない） */
function getWithHost(path: string, headers: Record<string, string>): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = request(`${base}${path}`, { headers }, (res) => {
      res.resume()
      resolve(res.statusCode ?? 0)
    })
    req.on('error', reject)
    req.end()
  })
}

const post = (path: string, headers: Record<string, string> = {}) => fetch(`${base}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: '{}' })
const detail = async (n: number) => (await (await fetch(`${base}/api/prs/o/known/${n}`)).json()) as PrDetailResponse

async function brief(name: string, html = '<!doctype html><title>作り物</title><p>作り物の解説</p>'): Promise<string> {
  const d = join(tmpRoot, name)
  await mkdir(d)
  await writeFile(join(d, 'brief.html'), html)
  return join(d, 'brief.html')
}

test('briefHtmlIn: 一時フォルダの直下の brief-pr-*/brief.html だけを拾う', async () => {
  const ok = await brief('brief-pr-ok1')
  assert.equal(await briefHtmlIn(`📄 [brief.html を開く](file://${ok})`, tmpRoot), ok)
  // 名前違い・深い所・一時フォルダの外・リポジトリの中・リンクは拾わない
  await mkdir(join(tmpRoot, 'other-1'))
  await writeFile(join(tmpRoot, 'other-1', 'brief.html'), 'x')
  await mkdir(join(tmpRoot, 'brief-pr-ok1', 'brief-pr-deep'))
  await writeFile(join(tmpRoot, 'brief-pr-ok1', 'brief-pr-deep', 'brief.html'), 'x')
  await mkdir(join(repoDir, 'brief-pr-in-repo'))
  await writeFile(join(repoDir, 'brief-pr-in-repo', 'brief.html'), 'x')
  await mkdir(join(tmpRoot, 'brief-pr-link'))
  await symlink(join(repoDir, 'brief-pr-in-repo', 'brief.html'), join(tmpRoot, 'brief-pr-link', 'brief.html'))
  await symlink(join(repoDir, 'brief-pr-in-repo'), join(tmpRoot, 'brief-pr-dirlink'))
  for (const p of [
    join(tmpRoot, 'other-1', 'brief.html'),
    join(tmpRoot, 'brief-pr-ok1', 'brief-pr-deep', 'brief.html'),
    join(repoDir, 'brief-pr-in-repo', 'brief.html'),
    join(tmpRoot, 'brief-pr-link', 'brief.html'),
    join(tmpRoot, 'brief-pr-dirlink', 'brief.html'),
    join(tmpRoot, 'brief-pr-none', 'brief.html'),
  ]) {
    assert.equal(await briefHtmlIn(`[開く](file://${p})`, tmpRoot), '', p)
  }
  // file:// でない書き方・ほかの名前は拾わない
  assert.equal(await briefHtmlIn(`\`open '${ok}'\``, tmpRoot), '')
  assert.equal(await briefHtmlIn(`file://${ok.replace('brief.html', 'index.html')}`, tmpRoot), '')
})

test('explainView: 回している間・開ける・消えた・見つからない・古い', () => {
  const rec = { session: 'x@known', head_sha: 'h1', at: '2026-11-01T00:00:00Z', path: '' }
  assert.equal(explainView(rec, { running: true, exists: false, head: 'h1' }).state, 'running')
  assert.equal(explainView({ ...rec, missing: true }, { running: false, exists: false, head: 'h1' }).state, 'failed')
  const ready = explainView({ ...rec, path: '/t/brief-pr-a/brief.html' }, { running: false, exists: true, head: 'h2' })
  assert.equal(ready.state, 'ready')
  assert.match(ready.key ?? '', /^[0-9a-f]{16}$/)
  assert.equal(ready.stale, true)
  assert.equal(explainView({ ...rec, path: '/t/brief-pr-a/brief.html' }, { running: false, exists: false, head: 'h1' }).state, 'gone')
})

test('開いただけでは回さない。記録のある worktree があればボタンを出す', async () => {
  const body = await detail(7)
  assert.equal(body.explain_available, true)
  assert.equal(body.explain, undefined)
  assert.equal(runner.started.length, 0)
})

test('別オリジン・知らないリポジトリは断る。GET では回さない', async () => {
  assert.equal((await post('/api/prs/o/known/7/explain', { Origin: 'http://evil.example' })).status, 403)
  assert.equal((await post('/api/prs/o/unknown/7/explain')).status, 404)
  assert.equal((await fetch(`${base}/api/prs/o/known/7/explain`)).status, 405, 'GET では回さない')
  assert.equal(runner.started.length, 0)
})

test('押すと /brief-pr <PR の URL> を新しいセッションで回す。権限のフラグは足さない。回している間は 2 本目を断る', async () => {
  const res = await post('/api/prs/o/known/7/explain')
  assert.equal(res.status, 202)
  const body = (await res.json()) as PrExplainResponse
  assert.equal(body.explain.state, 'running')
  assert.equal(runner.started.length, 1)
  const { id, cmd } = runner.started[0]!
  assert.equal(body.explain.session, id)
  assert.match(id, /@known$/)
  assert.equal(cmd.text, '/brief-pr https://github.com/o/known/pull/7')
  for (const flag of ['--dangerously-skip-permissions', '--allowedTools', '--allowed-tools']) assert.ok(!cmd.args.includes(flag), flag)
  assert.equal(prs.posted, 0, 'GitHub には書かない')
  assert.equal((await post('/api/prs/o/known/7/explain')).status, 409)
  assert.equal((await detail(7)).explain?.state, 'running')
})

test('回し終えたら返答の file:// から拾って鍵で配る。CSP: sandbox・nosniff・no-store。消えたら gone、head が進んだら古い', async () => {
  const { id } = runner.started[0]!
  const path = await brief('brief-pr-made', '<!doctype html><title>作り物</title><script>alert(1)</script><p>作り物の解説</p>')
  const done: FeedRow = row(new Date(), id.split('@')[0]!, { repo: 'known', cwd: repoDir, project: 'o/known', remote: 'https://github.com/o/known', text: `📄 [brief.html を開く](file://${path})\n\n要旨` })
  await appendFile(join(feedDir, `${localDate(new Date().toISOString())}.jsonl`), `${JSON.stringify(done)}\n`)
  runner.busy.delete(id)
  const shown = (await detail(7)).explain
  assert.equal(shown?.state, 'ready')
  assert.equal(shown?.stale, false)
  assert.ok(!JSON.stringify(shown).includes(tmpRoot), 'パスは画面に渡さない')
  const got = await fetch(`${base}/api/pr-explain/${shown?.key}`)
  assert.equal(got.status, 200)
  assert.equal(got.headers.get('content-security-policy'), 'sandbox')
  assert.equal(got.headers.get('x-content-type-options'), 'nosniff')
  assert.equal(got.headers.get('cache-control'), 'no-store')
  assert.match(got.headers.get('content-type') ?? '', /^text\/html/)
  assert.match(await got.text(), /作り物の解説/)
  // tailnet: whois で本人と分かれば Serve の名前で開ける。タグ付きの端末・知らない鍵は断る
  assert.equal(await getWithHost(`/api/pr-explain/${shown?.key}`, { ...TAILNET, Host: 'mac.tailnet.ts.net' }), 200)
  assert.equal(await getWithHost(`/api/pr-explain/${shown?.key}`, { 'X-Forwarded-For': '100.64.0.2', 'X-Forwarded-Proto': 'https', Host: 'mac.tailnet.ts.net' }), 401)
  assert.equal(await getWithHost(`/api/pr-explain/${shown?.key}`, { ...TAILNET, 'Tailscale-User-Login': 'someone@example.com', Host: 'mac.tailnet.ts.net' }), 401, 'whois と合わない')
  assert.equal((await fetch(`${base}/api/pr-explain/${'0'.repeat(16)}`)).status, 404)
  assert.equal((await fetch(`${base}/api/pr-explain/..%2Fx`)).status, 404)
  // head が進んだら古いと出る
  prs.headSha = 'b'.repeat(40)
  assert.equal((await detail(7)).explain?.stale, true)
  // 消えたら gone（作り直しのボタンにする）。配る口も 404
  await rm(join(tmpRoot, 'brief-pr-made'), { recursive: true })
  assert.equal((await detail(7)).explain?.state, 'gone')
  assert.equal((await fetch(`${base}/api/pr-explain/${shown?.key}`)).status, 404)
})

test('回し終えても HTML が見つからなければ failed', async () => {
  assert.equal((await post('/api/prs/o/known/8/explain')).status, 202)
  const { id } = runner.started.at(-1)!
  runner.busy.delete(id)
  assert.equal((await detail(8)).explain?.state, 'failed')
})
