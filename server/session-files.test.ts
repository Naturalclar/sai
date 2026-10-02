// GET /api/sessions/<id>/files/<key>（#603）。本物の createApp に一時の feed dir と作業ディレクトリを渡して、
// 返答の本文に出てきた作業ディレクトリの中の文字のファイルだけが読め、表に無い鍵・自分の入力に書いたパス・外のファイル・
// 名前で断るファイル・別のマシンのセッション・tailnet 越しは読めない（中身を返さない）ことを見る
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, request } from 'node:http'
import type { Server } from 'node:http'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SessionFileResponse } from '../shared/types.ts'
import { createApp } from './app.ts'
import { Authenticator } from './auth.ts'
import { FeedStore } from './rows/store.ts'
import { localDate } from './rows/aggregate.ts'
import { row } from './rows/aggregate.test.ts'
import { fileKey, sessionFileUrl } from '../shared/files.ts'

let dir: string
let server: Server
let base: string
const SECRET = 'TOKEN=very-secret'
const TAILNET = { 'Tailscale-User-Login': 'me@example.com', 'Tailscale-User-Name': 'Me', 'X-Forwarded-For': '100.64.0.1', 'X-Forwarded-Proto': 'https' }

const get = (id: string, src: string, init?: RequestInit) => fetch(`${base}${sessionFileUrl(id, src)}`, init)

before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'sai-files-'))
  const feedDir = join(dir, 'feed')
  const cwd = join(dir, 'work')
  await mkdir(feedDir)
  await mkdir(join(cwd, 'docs'), { recursive: true })
  await mkdir(join(dir, 'elsewhere'))
  await writeFile(join(cwd, 'docs', 'report.md'), '# 報告\n<script>alert(1)</script>\n')
  await writeFile(join(cwd, 'docs', 'typed.md'), '入力に書いただけ')
  await writeFile(join(cwd, 'credentials.json'), SECRET)
  await writeFile(join(cwd, '.env'), SECRET)
  await symlink(join(cwd, '.env'), join(cwd, 'notes.txt'))
  const outside = join(dir, 'elsewhere', 'plan.md')
  await writeFile(outside, SECRET)

  const now = new Date()
  const lines = [
    row(now, 'S1', {
      repo: 'repo',
      cwd,
      text: `\`docs/report.md:2\` を書いた。\`credentials.json\` と \`notes.txt\` と \`${outside}\` と \`gone.ts\` も`,
      user_text: '`docs/typed.md` を見て',
    }),
    // 別のマシンで記録された行。同じパスのファイルがこちらにあっても別物
    row(now, 'S2', { repo: 'repo', cwd, host: 'far-away-machine', text: '`docs/report.md`' }),
  ]
  await writeFile(join(feedDir, `${localDate(now.toISOString())}.jsonl`), lines.map((l) => JSON.stringify(l)).join('\n') + '\n')

  const auth = new Authenticator(async (addr) => (addr === '100.64.0.1' ? { login: 'me@example.com', tagged: false, node: 'laptop', caps: {} } : null), 30_000)
  const app = createApp(new FeedStore(feedDir), join(dir, 'dist'), undefined, undefined, undefined, undefined, auth)
  server = createServer((req, res) => void app(req, res))
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const addr = server.address()
  base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`
})

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
  await rm(dir, { recursive: true, force: true })
})

test('返答に出てきた作業ディレクトリの中のファイルを、文字として JSON で返す（HTML として配らない）', async () => {
  const res = await get('S1@repo', 'docs/report.md')
  assert.equal(res.status, 200)
  assert.match(res.headers.get('content-type') ?? '', /^application\/json/)
  const body = (await res.json()) as SessionFileResponse
  assert.deepEqual(body, { path: 'docs/report.md', name: 'report.md', text: '# 報告\n<script>alert(1)</script>\n', bytes: Buffer.byteLength('# 報告\n<script>alert(1)</script>\n') })
})

test('表に無い鍵・自分の入力に書いたパス・パスそのものを渡したものは 404', async () => {
  assert.equal((await get('S1@repo', 'docs/other.md')).status, 404)
  assert.equal((await get('S1@repo', 'docs/typed.md')).status, 404, '自分の入力は表に入れない')
  assert.equal((await fetch(`${base}/api/sessions/S1%40repo/files/docs%2Freport.md`)).status, 404, 'パスは受けない（鍵だけ）')
  assert.equal((await fetch(`${base}/api/sessions/S1%40repo/files/..%2F..%2Felsewhere%2Fplan.md`)).status, 404)
  assert.equal((await get('nobody@repo', 'docs/report.md')).status, 404)
})

test('名前で断るファイル・リンクの先が断る名前・作業ディレクトリの外・無いファイルは、中身を返さない', async () => {
  for (const [src, status] of [
    ['credentials.json', 403],
    ['notes.txt', 403],
    [join(dir, 'elsewhere', 'plan.md'), 403],
    ['gone.ts', 404],
  ] as const) {
    const res = await get('S1@repo', src)
    assert.equal(res.status, status, src)
    const text = await res.text()
    assert.ok(!text.includes('very-secret'), src)
    assert.ok((JSON.parse(text) as { error?: string }).error, '理由を 1 行返す')
  }
})

test('別のマシンのセッションのファイルは読まない', async () => {
  assert.equal((await get('S2@repo', 'docs/report.md')).status, 404)
})

test('tailnet 越し（Serve のヘッダ付き）には出さない。同じ人でもループバックからは読める', async () => {
  const far = await get('S1@repo', 'docs/report.md', { headers: TAILNET })
  assert.equal(far.status, 403)
  assert.ok(!(await far.text()).includes('報告'))
  // 認証そのものは通っている（一覧は読める）
  assert.equal((await fetch(`${base}/api/sessions`, { headers: TAILNET })).status, 200)
  assert.equal((await get('S1@repo', 'docs/report.md')).status, 200)
})

test('Host がループバックの名前でなければ出さない（外のページがホスト名を 127.0.0.1 に向け直しても読めない）', async () => {
  const withHost = (host: string) =>
    new Promise<{ status: number; body: string }>((resolve, reject) => {
      const url = new URL(`${base}${sessionFileUrl('S1@repo', 'docs/report.md')}`)
      const req = request({ host: url.hostname, port: url.port, path: url.pathname, headers: { Host: host } }, (res) => {
        let body = ''
        res.on('data', (c) => (body += c))
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body }))
      })
      req.on('error', reject)
      req.end()
    })
  const rebound = await withHost(`evil.example.com:${new URL(base).port}`)
  assert.equal(rebound.status, 403)
  assert.ok(!rebound.body.includes('報告'))
  assert.equal((await withHost(`localhost:${new URL(base).port}`)).status, 200)
})

test('書き込みのメソッドは受けない', async () => {
  const url = `${base}/api/sessions/S1%40repo/files/${fileKey('docs/report.md')}`
  for (const method of ['POST', 'PUT', 'DELETE']) assert.equal((await fetch(url, { method, headers: { Origin: base } })).status, 405, method)
})
