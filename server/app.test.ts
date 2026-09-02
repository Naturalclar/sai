import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import type { Server } from 'node:http'
import { mkdtemp, rm, writeFile, appendFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SessionsResponse, SessionDetailResponse, FeedResponse } from '../shared/types.ts'
import { createApp, parseDays } from './app.ts'
import { FeedStore } from './store.ts'
import { localDate } from './aggregate.ts'
import { row } from './aggregate.test.ts'

let dir: string
let feedDir: string
let distDir: string
let server: Server
let base: string
let store: FeedStore

const min = (n: number) => n * 60_000

before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'sai-'))
  feedDir = join(dir, 'feed')
  distDir = join(dir, 'dist')
  await mkdir(feedDir)
  const now = new Date()
  const lines = [
    JSON.stringify(row(new Date(now.getTime() - min(10)), 'S1', { first_user_text: '題名' })),
    'this line is broken',
    JSON.stringify(row(new Date(now.getTime() - min(5)), 'S1', { text: 'two' })),
    JSON.stringify(row(new Date(now.getTime() - min(1)), 'S2', { agent: 'codex', repo: 'sai' })),
  ]
  await writeFile(join(feedDir, `${localDate(now.toISOString())}.jsonl`), lines.join('\n') + '\n')
  store = new FeedStore(feedDir)
  server = createServer((req, res) => void createApp(store, distDir)(req, res))
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const addr = server.address()
  base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`
})

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
  await rm(dir, { recursive: true, force: true })
})

const get = (path: string) => fetch(base + path)

test('parseDays', () => {
  assert.equal(parseDays(null, 7), 7)
  assert.equal(parseDays('abc', 7), 7)
  assert.equal(parseDays('0', 7), 1)
  assert.equal(parseDays('9999', 7), 366)
  assert.equal(parseDays('3', 7), 3)
})

test('/ は未ビルドなら案内、あれば index.html', async () => {
  let res = await get('/')
  assert.equal(res.status, 200)
  assert.match(res.headers.get('content-type') ?? '', /text\/html/)
  assert.match(await res.text(), /pnpm build/)

  await mkdir(join(distDir, 'assets'), { recursive: true })
  await writeFile(join(distDir, 'index.html'), '<script src="/assets/a.js"></script>')
  await writeFile(join(distDir, 'assets', 'a.js'), 'console.log(1)')
  res = await get('/')
  assert.match(await res.text(), /\/assets\//)
  res = await get('/assets/a.js')
  assert.equal(res.status, 200)
  assert.match(res.headers.get('content-type') ?? '', /javascript/)
})

test('dist/ の外には出ない', async () => {
  assert.equal((await get('/assets/../../feed/x.jsonl')).status, 404)
  assert.equal((await get('/assets/%2e%2e/%2e%2e/etc/passwd')).status, 404)
  assert.equal((await get('/assets/nope.js')).status, 404)
})

test('/api/sessions', async () => {
  const res = await get('/api/sessions?days=7')
  assert.equal(res.status, 200)
  const data = (await res.json()) as SessionsResponse
  assert.deepEqual(data.sessions.map((s) => s.id), ['S2@sai', 'S1@kanban'])
  assert.deepEqual(data.filters.repos, ['kanban', 'sai'])
  assert.deepEqual(data.filters.agents, ['claude', 'codex'])
  assert.equal(data.sessions[1]!.turns, 2)
  assert.equal(data.sessions[1]!.title, '題名')
  assert.ok(data.rev)
})

test('/api/sessions は絞り込み前の全体から filters を作る', async () => {
  const data = (await (await get('/api/sessions?days=7&agent=codex')).json()) as SessionsResponse
  assert.deepEqual(data.sessions.map((s) => s.id), ['S2@sai'])
  assert.equal(data.total, 2)
  assert.deepEqual(data.filters.agents, ['claude', 'codex'])
})

test('/api/sessions/<id>', async () => {
  const res = await get(`/api/sessions/${encodeURIComponent('S1@kanban')}`)
  assert.equal(res.status, 200)
  const data = (await res.json()) as SessionDetailResponse
  assert.equal(data.session.id, 'S1@kanban')
  assert.deepEqual(data.rows.map((r) => r.text), ['hi', 'two'])
  assert.equal((await get('/api/sessions/S1')).status, 404, 'リポジトリ抜きの旧IDでは引けない')
  assert.equal((await get('/api/sessions/nope')).status, 404)
  assert.equal((await get('/api/sessions/')).status, 400)
})

test('/api/feed は壊れた行を落とす', async () => {
  const data = (await (await get('/api/feed?days=3')).json()) as FeedResponse
  assert.equal(data.rows.length, 3)
  const only = (await (await get('/api/feed?days=3&repo=sai')).json()) as FeedResponse
  assert.equal(only.rows.length, 1)
})

test('その他', async () => {
  assert.equal((await get('/favicon.ico')).status, 204)
  assert.equal((await get('/api/health')).status, 200)
  assert.equal((await get('/nope')).status, 404)
  assert.equal((await fetch(base + '/api/health', { method: 'POST' })).status, 405)
})

test('キャッシュは追記で無効になり、変わらなければ再パースしない', async () => {
  const d = await mkdtemp(join(tmpdir(), 'sai-cache-'))
  try {
    const now = new Date()
    const path = join(d, `${localDate(now.toISOString())}.jsonl`)
    await writeFile(path, JSON.stringify(row(new Date(now.getTime() - min(3)), 'S1')) + '\n')
    const s = new FeedStore(d)
    const first = await s.sessions(7)
    assert.equal(first.sessions.length, 1)
    const second = await s.sessions(7)
    assert.equal(first.rev, second.rev)
    assert.equal(first.sessions, second.sessions, '同じ配列が返る = 再集計していない')
    await appendFile(path, JSON.stringify(row(now, 'S2')) + '\n')
    const third = await s.sessions(7)
    assert.notEqual(first.rev, third.rev)
    assert.equal(third.sessions.length, 2)
  } finally {
    await rm(d, { recursive: true, force: true })
  }
})
