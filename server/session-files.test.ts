// GET /api/sessions/<id>/files/<key>（#603）。本物の createApp に一時の feed dir と作業ディレクトリを渡して、
// 返答の本文に出てきた作業ディレクトリの中の文字のファイルだけが読め、表に無い鍵・自分の入力に書いたパス・外のファイル・
// 名前で断るファイル・別のマシンのセッションは読めない（中身を返さない）ことと、出す相手（#768: ループバックと、whois で本人と分かった
// tailnet のユーザーの端末だけ。タグ付き・whois が聞けなかった要求・`/mcp`・Host が合わない要求には出さない）を見る
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, request } from 'node:http'
import type { Server } from 'node:http'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SessionFileResponse } from '../shared/types.ts'
import { createApp } from './app.ts'
import { Authenticator, WhoisUnavailable } from './auth.ts'
import type { WhoisInfo } from './auth.ts'
import { MCP_CAP } from './mcp/access.ts'
import { FeedStore } from './rows/store.ts'
import { localDate } from './rows/aggregate.ts'
import { row } from './rows/aggregate.test.ts'
import { fileKey, sessionFileUrl } from '../shared/files.ts'

let dir: string
let server: Server
let base: string
const SECRET = 'TOKEN=very-secret'
const TAILNET = { 'Tailscale-User-Login': 'me@example.com', 'Tailscale-User-Name': 'Me', 'X-Forwarded-For': '100.64.0.1', 'X-Forwarded-Proto': 'https' }

const SERVE_HOST = 'mac.tail1234.ts.net'
const TAGGED_ADDR = '100.64.0.7'
const DOWN_ADDR = '100.64.0.8'

const get = (id: string, src: string, init?: RequestInit) => fetch(`${base}${sessionFileUrl(id, src)}`, init)

/** `Host` を指定して送る（fetch は Host を差し替えられない）。Serve は `Host` を MagicDNS 名のまま渡してくる */
const send = (path: string, headers: Record<string, string>, body?: string) =>
  new Promise<{ status: number; type: string; body: string }>((resolve, reject) => {
    const url = new URL(base)
    const req = request({ host: url.hostname, port: url.port, path, method: body === undefined ? 'GET' : 'POST', headers }, (res) => {
      let text = ''
      res.on('data', (c) => (text += c))
      res.on('end', () => resolve({ status: res.statusCode ?? 0, type: String(res.headers['content-type'] ?? ''), body: text }))
    })
    req.on('error', reject)
    req.end(body)
  })

/** Serve 越しの本人の端末から */
const viaServe = (id: string, src: string) => send(sessionFileUrl(id, src), { ...TAILNET, Host: SERVE_HOST })

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

  const auth = new Authenticator(async (addr): Promise<WhoisInfo | null> => {
    if (addr === DOWN_ADDR) throw new WhoisUnavailable('timeout')
    if (addr === TAGGED_ADDR) return { login: 'tagged-devices', tagged: true, node: 'bot', caps: { [MCP_CAP]: [{ tools: ['read'] }] } }
    return addr === '100.64.0.1' ? { login: 'me@example.com', tagged: false, node: 'laptop', caps: {} } : null
  }, 30_000)
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

test('tailnet の本人の端末には出す（Serve の Host のとき）。ループバックも今までどおり読める', async () => {
  const far = await viaServe('S1@repo', 'docs/report.md')
  assert.equal(far.status, 200)
  assert.match(far.type, /^application\/json/, 'tailnet 越しでも JSON（ファイルそのものを配らない）')
  assert.equal((JSON.parse(far.body) as SessionFileResponse).text, '# 報告\n<script>alert(1)</script>\n')
  assert.equal((await get('S1@repo', 'docs/report.md')).status, 200)
})

test('tailnet 越しでも、断るものは同じに断る（名前・リンクの先・cwd の外・表に無い鍵・パスそのもの・別のマシン）', async () => {
  for (const [src, status] of [
    ['credentials.json', 403],
    ['notes.txt', 403],
    [join(dir, 'elsewhere', 'plan.md'), 403],
    ['gone.ts', 404],
    ['docs/other.md', 404],
    ['docs/typed.md', 404],
  ] as const) {
    const res = await viaServe('S1@repo', src)
    assert.equal(res.status, status, src)
    assert.ok(!res.body.includes('very-secret'), src)
  }
  assert.equal((await viaServe('S2@repo', 'docs/report.md')).status, 404, '別のマシンのセッション')
  for (const raw of ['docs%2Freport.md', '..%2F..%2Felsewhere%2Fplan.md', '.env']) {
    const res = await send(`/api/sessions/S1%40repo/files/${raw}`, { ...TAILNET, Host: SERVE_HOST })
    assert.equal(res.status, 404, raw)
    assert.ok(!res.body.includes('very-secret') && !res.body.includes('報告'), raw)
  }
})

test('タグ付きの端末・whois が聞けなかった要求・whois と合わない要求には出さない（中身も有無も返さない）', async () => {
  const path = sessionFileUrl('S1@repo', 'docs/report.md')
  const missing = sessionFileUrl('S1@repo', 'docs/other.md')
  for (const [name, headers] of [
    ['タグ付き（capability があっても）', { 'X-Forwarded-For': TAGGED_ADDR, 'X-Forwarded-Proto': 'https' }],
    ['whois が聞けなかった', { ...TAILNET, 'X-Forwarded-For': DOWN_ADDR }],
    ['whois が「居ない」', { ...TAILNET, 'X-Forwarded-For': '100.64.0.99' }],
    ['whois と別のログイン', { ...TAILNET, 'Tailscale-User-Login': 'other@example.com' }],
  ] as const) {
    const res = await send(path, { ...headers, Host: SERVE_HOST })
    assert.equal(res.status, 401, name)
    assert.ok(!res.body.includes('報告'), name)
    // ある鍵と無い鍵で応答が同じ（有無を漏らさない）
    const other = await send(missing, { ...headers, Host: SERVE_HOST })
    assert.deepEqual([other.status, other.body], [res.status, res.body], name)
  }
})

test('/mcp からは読めない（ファイルを読む道具が無く、口のパスも通らない）', async () => {
  const headers = { 'X-Forwarded-For': TAGGED_ADDR, 'X-Forwarded-Proto': 'https', Host: SERVE_HOST, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' }
  const list = await send('/mcp', headers, JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }))
  assert.equal(list.status, 200, list.body)
  const names = (JSON.parse(list.body) as { result: { tools: { name: string }[] } }).result.tools.map((t) => t.name)
  assert.ok(names.length > 0)
  assert.deepEqual(names.filter((n) => /file/i.test(n)), [])
  assert.equal((await send(`/mcp${sessionFileUrl('S1@repo', 'docs/report.md').replace('/api', '')}`, headers)).status, 401)
})

test('Host が合わなければ出さない（ループバックはループバックの名前、Serve 越しは Serve の名前）', async () => {
  const port = new URL(base).port
  const path = sessionFileUrl('S1@repo', 'docs/report.md')
  // ループバック: 外のページがホスト名を 127.0.0.1 に向け直しても読めない
  const rebound = await send(path, { Host: `evil.example.com:${port}` })
  assert.equal(rebound.status, 403)
  assert.ok(!rebound.body.includes('報告'))
  assert.equal((await send(path, { Host: `localhost:${port}` })).status, 200)
  // ループバックの直アクセスに Serve の名前を名乗らせても通らない（Serve のヘッダが無い）
  assert.equal((await send(path, { Host: SERVE_HOST })).status, 403)
  // Serve 越し: tailnet のアドレスに向け直した外の名前・ループバックの名前・`ts.net` に似せた名前では読めない
  for (const host of ['evil.example.com', `127.0.0.1:${port}`, 'localhost', 'ts.net', 'evil-ts.net', 'laptop.tail1234.ts.net.evil.example.com', '100.64.0.2']) {
    const res = await send(path, { ...TAILNET, Host: host })
    assert.equal(res.status, 403, host)
    assert.match((JSON.parse(res.body) as { error: string }).error, /^この端末からは読めません/, host)
    assert.ok(!res.body.includes('報告'), host)
    // 無い鍵でも同じ応答（引く前に断る）
    const other = await send(sessionFileUrl('S1@repo', 'docs/other.md'), { ...TAILNET, Host: host })
    assert.deepEqual([other.status, other.body], [res.status, res.body], host)
    // 認証そのものは通っている（ほかの口は Serve 越しの Host を見ない）
    assert.equal((await send('/api/health', { ...TAILNET, Host: host })).status, 200, host)
  }
  assert.equal((await send(path, { ...TAILNET, Host: `${SERVE_HOST.toUpperCase()}:443` })).status, 200)
})

test('書き込みのメソッドは受けない', async () => {
  const url = `${base}/api/sessions/S1%40repo/files/${fileKey('docs/report.md')}`
  for (const method of ['POST', 'PUT', 'DELETE']) assert.equal((await fetch(url, { method, headers: { Origin: base } })).status, 405, method)
})
