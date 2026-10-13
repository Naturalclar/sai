// POST /api/prs/<owner>/<repo>/<番号>/brief（#790）。PR の要約を作る口。PR を読む口と一言の口は差し替えるので、
// ネットワークにも gh にも LLM にも触らない。**押さなければ作らない・同じ材料で 2 回作らない・GitHub に書かない・
// 別オリジンと知らないリポジトリは断る**を見る。中身は作り物だけ。
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import type { Server } from 'node:http'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { PrBriefResponse, PrDetailResponse, PrSummary, ReplyError } from '../shared/types.ts'
import type { PrCommentList } from '../shared/prComments.ts'
import type { PrLineCommentList } from '../shared/prLineComments.ts'
import { createApp } from './app.ts'
import { FeedStore } from './rows/store.ts'
import { localDate } from './rows/aggregate.ts'
import { row } from './rows/aggregate.test.ts'
import { DIGEST_FILE, DigestStore, Digester } from './digest/digest.ts'
import type { Summarizer } from './digest/digest.ts'
import type { DigestProvider, SettingsResponse } from '../shared/types.ts'
import { PR_BRIEFS_FILE, PR_BRIEFS_MAX, PrBriefStore, briefFrom } from './git/prBriefs.ts'
import type { PrBrowser, PrView } from './git/prs.ts'

const summary = (number: number): PrSummary => ({
  number,
  title: `作り物の題名 ${number}`,
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
})

const PATCH = ['diff --git a/a.ts b/a.ts', '--- a/a.ts', '+++ b/a.ts', '@@ -1 +1,2 @@', '-old', '+見せる行', '', 'diff --git a/.env b/.env', '--- a/.env', '+++ b/.env', '@@ -1 +1 @@', '-K=1', '+K=ひみつの値', ''].join('\n')

class FakePrs implements PrBrowser {
  readonly available = true
  headSha = 'a'.repeat(40)
  patch: string | null = PATCH
  commentList: PrCommentList | null = { comments: [], omitted: 0 }
  lineList: PrLineCommentList | null = { comments: [], omitted: 0 }
  viewed: [string, number][] = []
  posted = 0
  async list() {
    return [summary(1)]
  }
  async view(repo: string, number: number): Promise<PrView | null> {
    this.viewed.push([repo, number])
    return { pr: { ...summary(number), body: '作り物の本文', state: 'OPEN', head_sha: this.headSha, cross_repo: false }, patch: this.patch }
  }
  async comments() {
    return this.commentList
  }
  async lineComments() {
    return this.lineList
  }
  async viewer() {
    return 'me'
  }
  async postReview(): Promise<{ ok: true; url: string }> {
    this.posted++
    return { ok: true, url: '' }
  }
}

class FakeSummarizer implements Summarizer {
  readonly where: string
  constructor(where = 'http://127.0.0.1:1/v1') {
    this.where = where
  }
  prompts: string[] = []
  answer: string | Error = '何を変える PR か\n作り物の要約'
  /** 立てると、放すまで答えない（同時の要求を見る） */
  gate: Promise<void> | null = null
  async summarize(prompt: string): Promise<string> {
    this.prompts.push(prompt)
    if (this.gate) await this.gate
    if (this.answer instanceof Error) throw this.answer
    return this.answer
  }
}

interface Booted {
  base: string
  server: Server
  feedDir: string
}

let dir: string
const prs = new FakePrs()
const fake = new FakeSummarizer()
let on: Booted
let off: Booted
/** 設定で PR の要約の口を選んだときに組まれた口（口とモデルを覚える） */
const built: { provider: DigestProvider; model: string; mouth: FakeSummarizer }[] = []

async function boot(name: string, enabled: boolean): Promise<Booted> {
  const feedDir = join(dir, name)
  await mkdir(feedDir)
  const now = new Date()
  await writeFile(join(feedDir, `${localDate(now.toISOString())}.jsonl`), `${JSON.stringify(row(now, 'S1', { repo: 'known', cwd: '/w/known', project: 'o/known', remote: 'https://github.com/o/known' }))}\n`)
  const store = new FeedStore(feedDir)
  const digester = new Digester(new DigestStore(join(feedDir, DIGEST_FILE)), fake, { enabled, model: 'm', persona: async () => 'none' })
  const terminal = {
    tmux: { run: async () => { throw new Error('unused') } },
    ps: async () => '',
    briefMouth: (provider: DigestProvider, model: string) => {
      const mouth = new FakeSummarizer(`fake ${provider} ${model}`)
      built.push({ provider, model, mouth })
      return mouth
    },
  }
  const app = createApp(store, join(dir, 'dist'), undefined, undefined, undefined, digester, undefined, terminal, undefined, undefined, undefined, undefined, undefined, undefined, prs)
  const server = createServer((req, res) => void app(req, res))
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const addr = server.address()
  return { base: `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`, server, feedDir }
}

before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'sai-pr-brief-'))
  on = await boot('on', true)
  off = await boot('off', false)
})

after(async () => {
  for (const b of [on, off]) await new Promise<void>((resolve) => b.server.close(() => resolve()))
  await rm(dir, { recursive: true, force: true })
})

const post = (b: Booted, path: string, headers: Record<string, string> = {}) => fetch(`${b.base}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: '{}' })
const detail = async (b: Booted, n: number) => (await (await fetch(`${b.base}/api/prs/o/known/${n}`)).json()) as PrDetailResponse

test('開いただけでは作らない。送り先は出す', async () => {
  fake.prompts = []
  const body = await detail(on, 7)
  assert.equal(body.brief, undefined)
  assert.equal(body.brief_via, 'http://127.0.0.1:1/v1')
  assert.equal(fake.prompts.length, 0)
})

test('押すと作って覚える。材料は題名・本文・差分で、秘密に見えるパスの中身は渡さない。GitHub には書かない', async () => {
  fake.prompts = []
  const res = await post(on, '/api/prs/o/known/7/brief')
  assert.equal(res.status, 200)
  const body = (await res.json()) as PrBriefResponse
  assert.equal(body.made, true)
  assert.equal(body.brief.text, '何を変える PR か\n作り物の要約')
  assert.equal(body.brief.head_sha, prs.headSha)
  assert.equal(body.brief.via, 'http://127.0.0.1:1/v1')
  assert.deepEqual(body.brief.notes, ['秘密に見える名前のファイル 1 個は渡していません'])
  assert.equal(fake.prompts.length, 1)
  const prompt = fake.prompts[0] ?? ''
  for (const shown of ['作り物の題名 7', '作り物の本文', '+見せる行']) assert.ok(prompt.includes(shown), shown)
  assert.ok(!prompt.includes('ひみつの値'))
  assert.equal(prs.posted, 0)
  // 覚えたものは次に開いたときに出る。置き場は記録の隣で、一言の digest.jsonl には書かない
  assert.equal((await detail(on, 7)).brief?.text, body.brief.text)
  const saved = JSON.parse(await readFile(join(on.feedDir, PR_BRIEFS_FILE), 'utf-8')) as Record<string, unknown>
  assert.deepEqual(Object.keys(saved), ['o/known#7'])
  await assert.rejects(readFile(join(on.feedDir, DIGEST_FILE), 'utf-8'))
})

test('同じ head・同じコメントの数なら、口を呼ばずに覚えたものを返す', async () => {
  fake.prompts = []
  const res = await post(on, '/api/prs/o/known/7/brief')
  const body = (await res.json()) as PrBriefResponse
  assert.equal(body.made, false)
  assert.equal(fake.prompts.length, 0)
})

test('push で head が変われば作り直す。開いたときは古い SHA のまま返す（画面が古いと分かる）', async () => {
  fake.prompts = []
  const prev = prs.headSha
  prs.headSha = 'b'.repeat(40)
  try {
    const opened = await detail(on, 7)
    assert.equal(opened.brief?.head_sha, prev)
    assert.equal(opened.pr.head_sha, prs.headSha)
    assert.equal(fake.prompts.length, 0)
    const body = (await (await post(on, '/api/prs/o/known/7/brief')).json()) as PrBriefResponse
    assert.equal(body.made, true)
    assert.equal(body.brief.head_sha, prs.headSha)
    assert.equal(fake.prompts.length, 1)
  } finally {
    prs.headSha = prev
  }
})

test('コメントが増えていれば作り直し、コメントを材料に入れる', async () => {
  await post(on, '/api/prs/o/known/8/brief')
  fake.prompts = []
  prs.commentList = { comments: [{ id: 'c1', kind: 'comment', author: 'reviewer-a', at: '2026-01-01T00:00:00Z', body: '作り物の指摘', url: '' }], omitted: 0 }
  try {
    const body = (await (await post(on, '/api/prs/o/known/8/brief')).json()) as PrBriefResponse
    assert.equal(body.made, true)
    assert.equal(body.brief.comments, 1)
    assert.ok(fake.prompts[0]?.includes('[コメント] reviewer-a: 作り物の指摘'))
  } finally {
    prs.commentList = { comments: [], omitted: 0 }
  }
})

test('同時に 2 回押しても、口を呼ぶのは 1 回', async () => {
  fake.prompts = []
  let release = () => {}
  fake.gate = new Promise<void>((resolve) => (release = resolve))
  try {
    const a = post(on, '/api/prs/o/known/9/brief')
    const b = post(on, '/api/prs/o/known/9/brief')
    // 2 本目がサーバに届くまで待ってから放す
    while (fake.prompts.length === 0) await new Promise((resolve) => setTimeout(resolve, 5))
    await new Promise((resolve) => setTimeout(resolve, 50))
    release()
    const [ra, rb] = await Promise.all([a, b])
    assert.equal(ra.status, 200)
    assert.equal(rb.status, 200)
    assert.equal(fake.prompts.length, 1)
  } finally {
    fake.gate = null
  }
})

test('口が落ちた・答えが空なら 502 で、覚えない。PR の画面は今までどおり出る', async () => {
  fake.answer = new Error('connect ECONNREFUSED')
  try {
    const res = await post(on, '/api/prs/o/known/10/brief')
    assert.equal(res.status, 502)
    assert.match(((await res.json()) as ReplyError).error, /要約を作れませんでした/)
    fake.answer = '   '
    assert.equal((await post(on, '/api/prs/o/known/10/brief')).status, 502)
  } finally {
    fake.answer = '何を変える PR か\n作り物の要約'
  }
  const body = await detail(on, 10)
  assert.equal(body.brief, undefined)
  assert.equal(body.pr.body, '作り物の本文')
  assert.equal(body.diff.files.length, 2)
})

test('別オリジンは断る。GET では作れない', async () => {
  fake.prompts = []
  const res = await post(on, '/api/prs/o/known/11/brief', { Origin: 'https://evil.example' })
  assert.equal(res.status, 403)
  assert.equal((await fetch(`${on.base}/api/prs/o/known/11/brief`)).status, 405)
  assert.equal(fake.prompts.length, 0)
})

test('知らないリポジトリ・番号の形でないものは断り、gh も口も呼ばない', async () => {
  fake.prompts = []
  prs.viewed = []
  for (const path of ['/api/prs/o/unknown/7/brief', '/api/prs/o/known/abc/brief', '/api/prs/o/known/7/x/brief', '/api/prs/o/known/-1/brief']) {
    assert.equal((await post(on, path)).status, 404, path)
  }
  assert.deepEqual(prs.viewed, [])
  assert.equal(fake.prompts.length, 0)
})

test('一言を切っている（口が無い）ときは送り先を出さず、押されても作らない', async () => {
  fake.prompts = []
  const body = await detail(off, 7)
  assert.equal(body.brief_via, undefined)
  const res = await post(off, '/api/prs/o/known/7/brief')
  assert.equal(res.status, 409)
  assert.equal(fake.prompts.length, 0)
})

test('置き場: 形の違うものは読まない。上限を超えたら古いものから落とす', async () => {
  assert.equal(briefFrom({ text: '', head_sha: 'a' }), null)
  assert.equal(briefFrom({ text: 't' }), null)
  assert.deepEqual(briefFrom({ text: 't', head_sha: 'a', notes: ['n', 1], comments: 'x' }), { text: 't', head_sha: 'a', at: '', comments: 0, notes: ['n'], via: '' })
  const path = join(dir, 'cap.json')
  await writeFile(path, '{ 壊れている')
  const store = new PrBriefStore(path)
  for (let i = 0; i <= PR_BRIEFS_MAX; i++) {
    await store.set('O/Known', i, { text: `t${i}`, head_sha: 'a', at: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString(), comments: 0, notes: [], via: '' })
  }
  assert.equal(await store.get('o/known', 0), undefined)
  assert.equal((await store.get('o/known', PR_BRIEFS_MAX))?.text, `t${PR_BRIEFS_MAX}`)
  // 別のインスタンスで読み直しても同じ
  assert.equal((await new PrBriefStore(path).get('o/known', 1))?.text, 't1')
})

const putSettings = async (b: Booted, body: object) => fetch(`${b.base}/api/settings`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })

test('設定で PR の要約の口を選ぶと、一言を切っていてもその口で作る。一言の口は呼ばない。空に戻すと一言と同じ口に戻る', async () => {
  fake.prompts = []
  built.length = 0
  let res = await putSettings(off, { pr_brief_provider: 'claude' })
  assert.equal(res.status, 200)
  assert.equal(((await res.json()) as SettingsResponse).pr_brief_provider, 'claude')
  try {
    // モデルが空なら口の既定
    assert.equal((await detail(off, 20)).brief_via, 'fake claude haiku')
    const body = (await (await post(off, '/api/prs/o/known/20/brief')).json()) as PrBriefResponse
    assert.equal(body.made, true)
    assert.equal(body.brief.via, 'fake claude haiku')
    assert.deepEqual(built.map((b) => [b.provider, b.model, b.mouth.prompts.length]), [['claude', 'haiku', 1]])
    assert.equal(fake.prompts.length, 0)
    // 同じ口・同じモデルの間は組み直さない。モデルを変えたら組み直す
    await post(off, '/api/prs/o/known/21/brief')
    assert.equal(built.length, 1)
    res = await putSettings(off, { pr_brief_model: ' sonnet ' })
    assert.equal(((await res.json()) as SettingsResponse).pr_brief_model, 'sonnet')
    assert.equal((await detail(off, 20)).brief_via, 'fake claude sonnet')
    assert.equal(built.length, 2)
    // openai の口はモデルが無ければ作れない
    await putSettings(off, { pr_brief_provider: 'openai', pr_brief_model: '' })
    assert.equal((await detail(off, 22)).brief_via, undefined)
    assert.equal((await post(off, '/api/prs/o/known/22/brief')).status, 409)
    // 形の違う値は断る
    assert.equal((await putSettings(off, { pr_brief_provider: 'gemini' })).status, 400)
    assert.equal((await putSettings(off, { pr_brief_model: '--dangerously-skip-permissions' })).status, 400)
  } finally {
    await putSettings(off, { pr_brief_provider: '', pr_brief_model: '' })
  }
  assert.equal((await detail(off, 23)).brief_via, undefined)
})

test('一言を入にしていても、PR の要約の口を選んでいればそちらで作る', async () => {
  fake.prompts = []
  built.length = 0
  await putSettings(on, { pr_brief_provider: 'claude', pr_brief_model: 'opus' })
  try {
    const body = (await (await post(on, '/api/prs/o/known/30/brief')).json()) as PrBriefResponse
    assert.equal(body.brief.via, 'fake claude opus')
    assert.equal(fake.prompts.length, 0)
  } finally {
    await putSettings(on, { pr_brief_provider: '', pr_brief_model: '' })
  }
  assert.equal((await detail(on, 31)).brief_via, 'http://127.0.0.1:1/v1')
})
