import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import type { Server } from 'node:http'
import { mkdtemp, rm, writeFile, appendFile, mkdir, stat, utimes } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ReplyResponse, SessionsResponse, SessionDetailResponse, FeedResponse } from '../shared/types.ts'
import { createApp, parseDays } from './app.ts'
import { FeedStore } from './store.ts'
import { localDate } from './aggregate.ts'
import { replyCommand } from './runner.ts'
import type { ReplyCommand, Runner } from './runner.ts'
import { row } from './aggregate.test.ts'

let dir: string
let feedDir: string
let distDir: string
let server: Server
let base: string
let store: FeedStore

/** 実際には起動しない。受け取ったコマンドを覚え、busy に入れた id は「進行中」と答える */
class FakeRunner implements Runner {
  started: { id: string; cmd: ReplyCommand }[] = []
  busy = new Set<string>()
  fail: Error | null = null
  running(id: string) {
    return this.busy.has(id)
  }
  async start(id: string, cmd: ReplyCommand) {
    if (this.fail) throw this.fail
    this.started.push({ id, cmd })
  }
}
const runner = new FakeRunner()

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
    // 返信用: cwd が実在する Claude / Codex のセッション、合成セッション、エージェント不明
    JSON.stringify(row(new Date(now.getTime() - min(4)), 'C1', { repo: 'r', cwd: dir })),
    JSON.stringify(row(new Date(now.getTime() - min(3)), 'X1', { agent: 'codex', repo: 'r', cwd: dir, session_source: 'rollout' })),
    JSON.stringify(row(new Date(now.getTime() - min(2)), 'synth-r-1', { repo: 'r', cwd: dir, session_source: 'synth' })),
    JSON.stringify(row(new Date(now.getTime() - min(2)), 'U1', { agent: 'unknown', repo: 'r', cwd: dir })),
  ]
  await writeFile(join(feedDir, `${localDate(now.toISOString())}.jsonl`), lines.join('\n') + '\n')
  store = new FeedStore(feedDir)
  server = createServer((req, res) => void createApp(store, distDir, runner)(req, res))
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

test('/api/* は X-SAI-Build（dist/index.html の mtime）を返し、ビルドし直すと変わる', async () => {
  const index = join(distDir, 'index.html')
  let res = await get('/api/health')
  const before = res.headers.get('x-sai-build')
  assert.equal(before, String((await stat(index)).mtimeMs))
  // 静的ファイルには付けない
  assert.equal((await get('/')).headers.get('x-sai-build'), null)

  // ビルドし直したつもりで mtime を進める
  const later = new Date(Date.now() + 5_000)
  await utimes(index, later, later)
  res = await get('/api/health')
  const after = res.headers.get('x-sai-build')
  assert.notEqual(after, before)
  assert.equal(after, String((await stat(index)).mtimeMs))
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
  assert.deepEqual(data.sessions.map((s) => s.id).slice(0, 2), ['S2@sai', 'synth-r-1@r'])
  assert.deepEqual(data.filters.repos, ['kanban', 'r', 'sai'])
  assert.deepEqual(data.filters.agents, ['claude', 'codex', 'unknown'])
  const s1 = data.sessions.find((s) => s.id === 'S1@kanban')!
  assert.equal(s1.turns, 2)
  assert.equal(s1.title, '題名')
  assert.ok(data.rev)
})

test('/api/sessions は絞り込み前の全体から filters を作る', async () => {
  const data = (await (await get('/api/sessions?days=7&agent=codex')).json()) as SessionsResponse
  assert.deepEqual(data.sessions.map((s) => s.id), ['S2@sai', 'X1@r'])
  assert.equal(data.total, 6)
  assert.deepEqual(data.filters.agents, ['claude', 'codex', 'unknown'])
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
  assert.equal(data.rows.length, 7)
  const only = (await (await get('/api/feed?days=3&repo=sai')).json()) as FeedResponse
  assert.equal(only.rows.length, 1)
})

test('その他', async () => {
  assert.equal((await get('/favicon.ico')).status, 204)
  assert.equal((await get('/api/health')).status, 200)
  assert.equal((await get('/nope')).status, 404)
  assert.equal((await fetch(base + '/api/health', { method: 'POST' })).status, 405)
  assert.equal((await fetch(base + '/api/sessions', { method: 'POST' })).status, 405)
  assert.equal((await get('/api/sessions/C1%40r/reply')).status, 405, 'GET では返信できない')
})

const post = (id: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(`${base}/api/sessions/${encodeURIComponent(id)}/reply`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })

test('POST reply: Claude のセッションを cwd で再開する', async () => {
  runner.started.length = 0
  const res = await post('C1@r', { text: '  続きをやって  ' })
  assert.equal(res.status, 202)
  const data = (await res.json()) as ReplyResponse
  assert.equal(data.accepted, true)
  assert.equal(data.id, 'C1@r')
  assert.equal(data.session, 'C1', 'CLI に渡すのはエンティティIDではなく生のセッションID')
  assert.equal(data.cwd, dir)
  assert.equal(runner.started.length, 1)
  const { id, cmd } = runner.started[0]!
  assert.equal(id, 'C1@r')
  assert.equal(cmd.cwd, dir)
  assert.deepEqual(cmd.args, ['-p', '--resume', 'C1', '続きをやって'])
})

test('POST reply: Codex は codex exec resume', async () => {
  runner.started.length = 0
  assert.equal((await post('X1@r', { text: 'go' })).status, 202)
  assert.deepEqual(runner.started[0]!.cmd.args, ['exec', 'resume', 'X1', 'go'])
})

test('POST reply: 合成・不明・cwd 無しは受け付けない', async () => {
  runner.started.length = 0
  let res = await post('synth-r-1@r', { text: 'x' })
  assert.equal(res.status, 400)
  assert.match(((await res.json()) as { error: string }).error, /合成/)
  res = await post('U1@r', { text: 'x' })
  assert.equal(res.status, 400)
  res = await post('S1@kanban', { text: 'x' })
  assert.equal(res.status, 400, 'cwd /home/u/kanban は無い')
  assert.match(((await res.json()) as { error: string }).error, /cwd/)
  assert.equal((await post('nope@r', { text: 'x' })).status, 404)
  assert.equal(runner.started.length, 0)
})

test('POST reply: body の検査', async () => {
  runner.started.length = 0
  assert.equal((await post('C1@r', { text: '   ' })).status, 400)
  assert.equal((await post('C1@r', {})).status, 400)
  assert.equal((await post('C1@r', 'not json')).status, 400)
  assert.equal((await post('C1@r', { text: 'x'.repeat(70 * 1024) })).status, 400)
  assert.equal(runner.started.length, 0)
})

test('POST reply: 別オリジンは 403、同一オリジンとブラウザ以外は通る', async () => {
  runner.started.length = 0
  const host = base.replace('http://', '')
  assert.equal((await post('C1@r', { text: 'x' }, { Origin: 'http://evil.local:8787' })).status, 403)
  assert.equal((await post('C1@r', { text: 'x' }, { Origin: 'null' })).status, 403)
  assert.equal((await post('C1@r', { text: 'x' }, { 'Sec-Fetch-Site': 'cross-site' })).status, 403)
  assert.equal((await post('C1@r', { text: 'x' }, { Origin: `http://${host}`, 'Sec-Fetch-Site': 'cross-site' })).status, 403)
  assert.equal(runner.started.length, 0)
  assert.equal((await post('C1@r', { text: 'x' }, { Origin: `http://${host}`, 'Sec-Fetch-Site': 'same-origin' })).status, 202)
  assert.equal(runner.started.length, 1)
})

test('POST reply: 進行中なら 409、起動できなければ 500', async () => {
  runner.started.length = 0
  runner.busy.add('C1@r')
  try {
    const res = await post('C1@r', { text: 'x' })
    assert.equal(res.status, 409)
  } finally {
    runner.busy.delete('C1@r')
  }
  runner.fail = Object.assign(new Error('spawn claude ENOENT'), { code: 'ENOENT' })
  try {
    const res = await post('C1@r', { text: 'x' })
    assert.equal(res.status, 500)
    assert.match(((await res.json()) as { error: string }).error, /SAI_CLAUDE_BIN/)
  } finally {
    runner.fail = null
  }
  assert.equal(runner.started.length, 0)
})

test('replyCommand は SAI_*_BIN で実行ファイルを差し替えられる', () => {
  assert.deepEqual(replyCommand('claude', 'S', 'hi', '/w', {}), { bin: 'claude', args: ['-p', '--resume', 'S', 'hi'], cwd: '/w' })
  assert.equal(replyCommand('claude', 'S', 'hi', '/w', { SAI_CLAUDE_BIN: '/opt/claude' })!.bin, '/opt/claude')
  assert.equal(replyCommand('codex', 'S', 'hi', '/w', { SAI_CODEX_BIN: '/opt/codex' })!.bin, '/opt/codex')
  assert.equal(replyCommand('unknown', 'S', 'hi', '/w', {}), null)
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
