import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import type { Server } from 'node:http'
import { mkdtemp, rm, writeFile, appendFile, mkdir, stat, utimes, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Replying, ReplyResponse, SessionsResponse, SessionDetailResponse, SessionIconResponse, SessionMetaResponse, FeedResponse, SettingsResponse, DigestBackfillResponse, HealthResponse } from '../shared/types.ts'
import { createApp, parseDays, revWith, sessionIdFrom, stripThinking } from './app.ts'
import { BuildFreshness } from './buildFreshness.ts'
import { Authenticator } from './auth.ts'
import { DigestStore, Digester } from './digest.ts'
import type { Summarizer } from './digest.ts'
import { FeedStore } from './store.ts'
import { localDate } from './aggregate.ts'
import { replyCommand, splitArgs } from './runner.ts'
import type { ReplyCommand, Runner } from './runner.ts'
import { row } from './aggregate.test.ts'
import { JPEG, PNG } from './icons.test.ts'

let dir: string
let feedDir: string
let distDir: string
let srcDir: string
let server: Server
let base: string
let store: FeedStore
let auth: Authenticator

/** 実際には起動しない。受け取ったコマンドを覚え、busy に入れた id は「進行中」と答える */
class FakeRunner implements Runner {
  started: { id: string; cmd: ReplyCommand }[] = []
  busy = new Map<string, Replying>()
  fail: Error | null = null
  running(id: string) {
    return this.busy.has(id)
  }
  snapshot() {
    return Object.fromEntries(this.busy)
  }
  async start(id: string, cmd: ReplyCommand) {
    if (this.fail) throw this.fail
    this.started.push({ id, cmd })
  }
}
const runner = new FakeRunner()

/** 一言（digest）の偽物。プロンプトの本文の先頭を返す。null を返す設定なら失敗 */
class FakeSummarizer implements Summarizer {
  prompts: string[] = []
  fail = false
  async summarize(prompt: string): Promise<string> {
    this.prompts.push(prompt)
    if (this.fail) throw new Error('fake failure')
    return `一言: ${(prompt.split('\n---\n')[1] ?? '').slice(0, 8)}`
  }
}
const summarizer = new FakeSummarizer()
let digester: Digester

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
    JSON.stringify(row(new Date(now.getTime() - min(5)), 'S1', { text: 'two', user_text: '続きの題名', thinking: '考えた' })),
    JSON.stringify(row(new Date(now.getTime() - min(1)), 'S2', { agent: 'codex', repo: 'sai' })),
    // 返信用: cwd が実在する Claude / Codex のセッション、合成セッション、エージェント不明
    JSON.stringify(row(new Date(now.getTime() - min(4)), 'C1', { repo: 'r', cwd: dir })),
    JSON.stringify(row(new Date(now.getTime() - min(3)), 'X1', { agent: 'codex', repo: 'r', cwd: dir, session_source: 'rollout' })),
    JSON.stringify(row(new Date(now.getTime() - min(2)), 'synth-r-1', { repo: 'r', cwd: dir, session_source: 'synth' })),
    JSON.stringify(row(new Date(now.getTime() - min(2)), 'U1', { agent: 'unknown', repo: 'r', cwd: dir })),
  ]
  await writeFile(join(feedDir, `${localDate(now.toISOString())}.jsonl`), lines.join('\n') + '\n')
  store = new FeedStore(feedDir)
  // アプリは 1 つ（答え待ちの承認はメモリに持つので、リクエストごとに作り直すと消える）
  // ビルドが古いかは、この dist と temp の src ディレクトリの mtime で判定させる（ttl 0 で毎回見る）
  srcDir = join(dir, 'src')
  await mkdir(srcDir)
  digester = new Digester(new DigestStore(join(feedDir, 'digest.jsonl')), summarizer, { enabled: true, model: 'fake', persona: async () => 'none' })
  // 認証は whois を差し替える: 100.64.0.1 の持ち主は me@example.com、それ以外は引けない
  auth = new Authenticator(async (addr) => (addr === '100.64.0.1' ? 'me@example.com' : null), 30_000)
  const app = createApp(store, distDir, runner, undefined, new BuildFreshness(distDir, [srcDir], 0), digester, auth)
  server = createServer((req, res) => void app(req, res))
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
  const first = res.headers.get('x-sai-build')
  assert.equal(first, String((await stat(index)).mtimeMs))
  // 静的ファイルには付けない
  assert.equal((await get('/')).headers.get('x-sai-build'), null)

  // ビルドし直したつもりで mtime を進める
  const later = new Date(Date.now() + 5_000)
  await utimes(index, later, later)
  res = await get('/api/health')
  const second = res.headers.get('x-sai-build')
  assert.notEqual(second, first)
  assert.equal(second, String((await stat(index)).mtimeMs))
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
  assert.equal(s1.title, '続きの題名', '一番新しい user_text がタイトル')
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

test('build_stale: dist がソースより古ければ true になり rev も変わる。ビルドし直せば false', async () => {
  const index = join(distDir, 'index.html')
  const src = join(srcDir, 'App.tsx')
  const initial = (await (await get('/api/sessions?days=7')).json()) as SessionsResponse
  assert.equal(initial.build_stale, false, 'ソースがまだ無い')

  // ソースを dist より新しくする
  await writeFile(src, '')
  const later = new Date((await stat(index)).mtimeMs + 60_000)
  await utimes(src, later, later)
  const stale = (await (await get('/api/sessions?days=7')).json()) as SessionsResponse
  assert.equal(stale.build_stale, true)
  assert.notEqual(stale.rev, initial.rev, '画面が拾えるよう rev が変わる')
  const feed = (await (await get('/api/feed?days=3')).json()) as FeedResponse
  assert.equal(feed.build_stale, true, 'フィードにも載る')

  // ビルドし直したつもりで dist を新しくする
  const rebuilt = new Date(later.getTime() + 60_000)
  await utimes(index, rebuilt, rebuilt)
  const fresh = (await (await get('/api/sessions?days=7')).json()) as SessionsResponse
  assert.equal(fresh.build_stale, false)
  assert.equal(fresh.rev, initial.rev, '元に戻れば rev も戻る')
})

test('sessionIdFrom: 空・/ 入り・壊れた %-エンコードは null。詳細だけ末尾の / を許す', () => {
  assert.equal(sessionIdFrom('/api/sessions/S1%40kanban'), 'S1@kanban')
  assert.equal(sessionIdFrom('/api/sessions/S1%40kanban/'), 'S1@kanban')
  assert.equal(sessionIdFrom('/api/sessions/S1%40kanban/meta', '/meta'), 'S1@kanban')
  assert.equal(sessionIdFrom('/api/sessions/S1%40kanban/reply', '/reply'), 'S1@kanban')
  assert.equal(sessionIdFrom('/api/sessions/'), null)
  assert.equal(sessionIdFrom('/api/sessions//meta', '/meta'), null)
  assert.equal(sessionIdFrom('/api/sessions/a%2Fb'), null, 'デコード後の / も断る')
  assert.equal(sessionIdFrom('/api/sessions/%E0%A4%A'), null, 'URIError を投げない')
  assert.equal(sessionIdFrom('/api/sessions/%E0%A4%A/meta', '/meta'), null)
  assert.equal(sessionIdFrom('/api/sessions/%'), null)
})

test('id の %-エンコードが壊れていれば 3 経路とも 400（500 にしない）', async () => {
  for (const path of ['/api/sessions/%E0%A4%A', '/api/sessions/%E0%A4%A/meta', '/api/sessions/%/meta']) {
    const res = await get(path)
    assert.equal(res.status, 400, path)
    assert.deepEqual(await res.json(), { error: 'bad session id' }, path)
  }
  const res = await fetch(`${base}/api/sessions/%E0%A4%A/reply`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: 'x' }),
  })
  assert.equal(res.status, 400)
  assert.deepEqual(await res.json(), { error: 'bad session id' })
  // 正しい id は今までどおり
  assert.equal((await get('/api/sessions/S1%40kanban/')).status, 200, '詳細は末尾の / を許す')
})

test('thinking はセッション詳細の行には載り、フィードの行からは落ちる', async () => {
  const detail = (await (await get('/api/sessions/S1%40kanban?days=3')).json()) as SessionDetailResponse
  assert.deepEqual(detail.rows.map((r) => r.thinking ?? ''), ['', '考えた'])
  const feed = (await (await get('/api/feed?days=3')).json()) as FeedResponse
  assert.ok(feed.rows.length > 0)
  assert.ok(feed.rows.every((r) => !('thinking' in r)), 'フィードには thinking を運ばない')
  assert.ok(feed.rows.some((r) => r.text === 'two'), '行そのものは残る')
  // 無い行はコピーせずそのまま
  const plain = row(new Date(), 'X')
  assert.equal(stripThinking(plain), plain)
  const withThinking = row(new Date(), 'X', { thinking: 't' })
  assert.equal(stripThinking(withThinking).thinking, undefined)
  assert.equal(withThinking.thinking, 't', '元の行は変えない')
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
  // 許可・質問を画面で答える配線（--mcp-config は SAI 自身の MCP サーバ、宛先はブラウザが来た Host）
  assert.deepEqual(cmd.args.slice(0, 1), ['--mcp-config'])
  assert.deepEqual(cmd.args.slice(2), ['--permission-prompt-tool', 'mcp__sai__approve', '-p', '--resume', 'C1', '--', '続きをやって'])
  const mcp = JSON.parse(cmd.args[1]!) as { mcpServers: { sai: { type: string; command: string; args: string[]; env: Record<string, string> } } }
  assert.equal(mcp.mcpServers.sai.type, 'stdio')
  assert.equal(mcp.mcpServers.sai.env.SAI_URL, base)
  assert.equal(mcp.mcpServers.sai.env.SAI_ENTITY, 'C1@r')
  assert.match(mcp.mcpServers.sai.args[mcp.mcpServers.sai.args.length - 1]!, /approve-mcp\.ts$/)
})

test('POST reply: Codex は codex exec resume', async () => {
  runner.started.length = 0
  assert.equal((await post('X1@r', { text: 'go' })).status, 202)
  assert.deepEqual(runner.started[0]!.cmd.args, ['exec', 'resume', 'X1', '--', 'go'])
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

test('処理中の返信は一覧・詳細・フィードの replying に載り、rev も変わる', async () => {
  const quiet = {
    sessions: (await (await get('/api/sessions?days=7')).json()) as SessionsResponse,
    detail: (await (await get('/api/sessions/C1%40r?days=7')).json()) as SessionDetailResponse,
    feed: (await (await get('/api/feed?days=7')).json()) as FeedResponse,
  }
  assert.deepEqual(quiet.sessions.replying, {})
  assert.deepEqual(quiet.detail.replying, {})
  assert.deepEqual(quiet.feed.replying, {})

  const entry: Replying = { since: '2026-09-02T12:00:00.000Z', text: '続きをやって' }
  runner.busy.set('C1@r', entry)
  try {
    const sessions = (await (await get('/api/sessions?days=7')).json()) as SessionsResponse
    assert.deepEqual(sessions.replying, { 'C1@r': entry })
    assert.notEqual(sessions.rev, quiet.sessions.rev, 'JSONL が変わらなくても rev が変わる（画面が再描画する）')
    const detail = (await (await get('/api/sessions/C1%40r?days=7')).json()) as SessionDetailResponse
    assert.deepEqual(detail.replying, { 'C1@r': entry })
    assert.notEqual(detail.rev, quiet.detail.rev)
    const feed = (await (await get('/api/feed?days=7')).json()) as FeedResponse
    assert.deepEqual(feed.replying, { 'C1@r': entry })
    assert.notEqual(feed.rev, quiet.feed.rev)
  } finally {
    runner.busy.delete('C1@r')
  }
  // 終わったら元の rev に戻る
  assert.equal(((await (await get('/api/sessions?days=7')).json()) as SessionsResponse).rev, quiet.sessions.rev)
})

test('revWith は処理中の集合と since で変わり、空なら素の rev', () => {
  const a: Replying = { since: '2026-09-02T12:00:00.000Z', text: 'x' }
  const b: Replying = { since: '2026-09-02T12:05:00.000Z', text: 'x' }
  assert.equal(revWith('r1', {}), 'r1')
  assert.notEqual(revWith('r1', { A: a }), 'r1')
  assert.equal(revWith('r1', { A: a, B: b }), revWith('r1', { B: b, A: a }), '順序に依らない')
  assert.notEqual(revWith('r1', { A: a }), revWith('r1', { A: b }), '同じ id でも since が違えば別（連続した返信）')
  assert.notEqual(revWith('r1', { A: a }), revWith('r2', { A: a }))
})

test('POST reply: 進行中なら 409、起動できなければ 500', async () => {
  runner.started.length = 0
  runner.busy.set('C1@r', { since: new Date().toISOString(), text: 'x' })
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

const putMeta = (id: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(`${base}/api/sessions/${encodeURIComponent(id)}/meta`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })

test('PUT meta: 表示名が一覧と詳細に載り、rev が変わり、ファイルに残る', async () => {
  const initial = (await (await get('/api/sessions?days=7')).json()) as SessionsResponse
  assert.equal(initial.sessions.find((s) => s.id === 'C1@r')!.meta, undefined)

  let res = await putMeta('C1@r', { name: '  README  直し\n', icon: '🧪' })
  assert.equal(res.status, 200)
  let data = (await res.json()) as SessionMetaResponse
  assert.deepEqual(data, { id: 'C1@r', meta: { name: 'README 直し' } }, '空白は詰め、前後は落とす。昔の絵文字の icon は捨てる')

  const updated = (await (await get('/api/sessions?days=7')).json()) as SessionsResponse
  assert.notEqual(updated.rev, initial.rev, '名前を付けただけでも rev が変わる（画面のポーリングが拾う）')
  assert.deepEqual(updated.sessions.find((s) => s.id === 'C1@r')!.meta, { name: 'README 直し' })
  assert.equal(updated.sessions.find((s) => s.id === 'X1@r')!.meta, undefined, '他のセッションには付かない')
  assert.equal(
    updated.sessions.find((s) => s.id === 'C1@r')!.title,
    initial.sessions.find((s) => s.id === 'C1@r')!.title,
    'title は元のまま（画面側で出し分ける）',
  )
  const detail = (await (await get('/api/sessions/C1%40r')).json()) as SessionDetailResponse
  assert.deepEqual(detail.session.meta, { name: 'README 直し' })
  res = await get('/api/sessions/C1%40r/meta')
  assert.deepEqual(await res.json(), { id: 'C1@r', meta: { name: 'README 直し' } })

  const file = JSON.parse(await readFile(join(feedDir, 'session-meta.json'), 'utf-8')) as Record<string, unknown>
  assert.deepEqual(file, { 'C1@r': { name: 'README 直し' } })

  // 省略したキーは据え置き。名前を消す → エントリごと消える
  res = await putMeta('C1@r', { archived_at: '2000-01-01T00:00:00Z' })
  assert.deepEqual(((await res.json()) as SessionMetaResponse).meta, { name: 'README 直し', archived_at: '2000-01-01T00:00:00.000Z' }, 'name は省略なので残る')
  res = await putMeta('C1@r', { archived_at: '' })
  assert.deepEqual(((await res.json()) as SessionMetaResponse).meta, { name: 'README 直し' })
  res = await putMeta('C1@r', { name: '' })
  assert.deepEqual(((await res.json()) as SessionMetaResponse).meta, {})
  const gone = (await (await get('/api/sessions?days=7')).json()) as SessionsResponse
  assert.equal(gone.sessions.find((s) => s.id === 'C1@r')!.meta, undefined)
  assert.deepEqual(JSON.parse(await readFile(join(feedDir, 'session-meta.json'), 'utf-8')), {})
  assert.deepEqual(await (await get('/api/sessions/C1%40r/meta')).json(), { id: 'C1@r', meta: {} }, '無ければ空')
})

test('PUT meta: 検査', async () => {
  const bad = async (body: unknown, re: RegExp) => {
    const res = await putMeta('C1@r', body)
    assert.equal(res.status, 400)
    assert.match(((await res.json()) as { error: string }).error, re)
  }
  await bad({ name: 'x'.repeat(101) }, /100 文字/)
  await bad({ name: 1 }, /文字列/)
  await bad('not json', /JSON|Unexpected|token/i)
  await bad([1], /オブジェクト/)
  assert.equal((await putMeta('C1@r', { name: 'x'.repeat(5 * 1024) })).status, 400, '大きすぎる body')
  assert.equal((await putMeta('nope@r', { name: 'x' })).status, 404, '窓の中に無いセッションには付けない')
  assert.equal((await putMeta('', { name: 'x' })).status, 400, 'id が空')
})

const TAILNET = { 'Tailscale-User-Login': 'me@example.com', 'Tailscale-User-Name': 'Me', 'X-Forwarded-For': '100.64.0.1', 'X-Forwarded-Proto': 'https' }

test('認証: ヘッダ無しのローカル直アクセスは通り、viewer は null', async () => {
  const health = (await (await get('/api/health')).json()) as HealthResponse
  assert.deepEqual(health, { ok: true, viewer: null })
  const list = (await (await get('/api/sessions?days=7')).json()) as SessionsResponse
  assert.equal(list.viewer, null)
})

test('認証: Tailscale-User-Login は whois と一致したときだけ通り、viewer にログイン名が載る', async () => {
  const res = await fetch(`${base}/api/health`, { headers: TAILNET })
  assert.equal(res.status, 200)
  assert.deepEqual(((await res.json()) as HealthResponse).viewer, { login: 'me@example.com', name: 'Me' })
  const list = (await (await fetch(`${base}/api/sessions?days=7`, { headers: TAILNET })).json()) as SessionsResponse
  assert.deepEqual(list.viewer, { login: 'me@example.com', name: 'Me' })
  // 画面（静的ファイル）も同じ検査を通る
  assert.equal((await fetch(`${base}/`, { headers: TAILNET })).status, 200)
})

test('認証: ヘッダだけ付けても 401（whois と突き合わせている）', async () => {
  const forged = async (headers: Record<string, string>) => (await fetch(`${base}/api/health`, { headers })).status
  assert.equal(await forged({ 'Tailscale-User-Login': 'someone@example.com' }), 401, 'X-Forwarded-For が無い')
  assert.equal(await forged({ 'Tailscale-User-Login': 'someone@example.com', 'X-Forwarded-For': '100.64.0.1' }), 401, 'whois は me@example.com')
  assert.equal(await forged({ 'Tailscale-User-Login': 'me@example.com', 'X-Forwarded-For': '100.64.0.9' }), 401, 'whois で引けない')
  assert.equal(await forged({ 'Tailscale-User-Login': 'ME@example.com', 'X-Forwarded-For': '100.64.0.1' }), 200, '大文字小文字は無視')
  // 静的ファイルも 401
  assert.equal((await fetch(`${base}/`, { headers: { 'Tailscale-User-Login': 'someone@example.com', 'X-Forwarded-For': '100.64.0.1' } })).status, 401)
})

test('認証: Serve 経由の書き込みは Origin が https://<host> になるが、X-Forwarded-Proto で同一オリジンと分かる', async () => {
  const host = base.replace('http://', '')
  const put = (headers: Record<string, string>) =>
    fetch(`${base}/api/sessions/C1%40r/meta`, { method: 'PUT', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify({}) })
  assert.equal((await put({ ...TAILNET, Origin: `https://${host}` })).status, 200, 'Serve 経由の同一オリジン')
  assert.equal((await put({ ...TAILNET, Origin: `http://${host}` })).status, 403, 'https 経由なのに http の Origin は別オリジン')
  assert.equal((await put({ ...TAILNET, Origin: 'https://evil.example' })).status, 403)
  assert.equal((await put({ Origin: `http://${host}` })).status, 200, '直アクセスは今までどおり http')
  assert.equal((await put({ Origin: `https://${host}` })).status, 403, '直アクセスで https の Origin は別オリジン（X-Forwarded-Proto 無し）')
})

test('PUT meta: 別オリジンは 403、メソッド違いは 405', async () => {
  const host = base.replace('http://', '')
  assert.equal((await putMeta('C1@r', { name: 'x' }, { Origin: 'http://evil.local:8787' })).status, 403)
  assert.equal((await putMeta('C1@r', { name: 'x' }, { 'Sec-Fetch-Site': 'cross-site' })).status, 403)
  assert.equal((await putMeta('C1@r', { name: 'x' }, { Origin: `http://${host}`, 'Sec-Fetch-Site': 'same-origin' })).status, 200)
  await putMeta('C1@r', { name: '' }) // PUT は重ねる意味なので {} では消えない
  assert.equal((await fetch(`${base}/api/sessions/C1%40r/meta`, { method: 'POST' })).status, 405)
  assert.equal((await fetch(`${base}/api/sessions/C1%40r/reply`, { method: 'PUT' })).status, 405)
  assert.equal((await fetch(`${base}/api/sessions`, { method: 'PUT' })).status, 405)
})

const putIcon = (id: string, body: string | Uint8Array, headers: Record<string, string> = {}) =>
  fetch(`${base}/api/sessions/${encodeURIComponent(id)}/icon`, { method: 'PUT', headers, body })
const deleteIcon = (id: string, headers: Record<string, string> = {}) =>
  fetch(`${base}/api/sessions/${encodeURIComponent(id)}/icon`, { method: 'DELETE', headers })

test('PUT icon: 画像を置くと一覧・詳細に URL が載り、GET で返り、rev が変わり、DELETE で消える', async () => {
  const initial = (await (await get('/api/sessions?days=7')).json()) as SessionsResponse
  assert.equal(initial.sessions.find((s) => s.id === 'C1@r')!.icon, undefined)
  assert.equal((await get('/api/sessions/C1%40r/icon')).status, 404, '無ければ 404')

  let res = await putIcon('C1@r', PNG)
  assert.equal(res.status, 200)
  const put = (await res.json()) as SessionIconResponse
  assert.equal(put.id, 'C1@r')
  assert.match(put.icon!, /^\/api\/sessions\/C1%40r\/icon\?v=[\d.]+$/)

  const updated = (await (await get('/api/sessions?days=7')).json()) as SessionsResponse
  assert.notEqual(updated.rev, initial.rev, '画像を置いただけでも rev が変わる')
  assert.equal(updated.sessions.find((s) => s.id === 'C1@r')!.icon, put.icon)
  assert.equal(updated.sessions.find((s) => s.id === 'C1@r')!.meta, undefined, '画像は meta には入らない')
  assert.equal(updated.sessions.find((s) => s.id === 'X1@r')!.icon, undefined, '他のセッションには付かない')
  const detail = (await (await get('/api/sessions/C1%40r')).json()) as SessionDetailResponse
  assert.equal(detail.session.icon, put.icon)
  assert.equal(await stat(join(feedDir, 'session-icons')).then((s) => s.isDirectory()), true)
  assert.deepEqual(JSON.parse(await readFile(join(feedDir, 'session-meta.json'), 'utf-8').catch(() => '{}')), {}, 'session-meta.json には書かない')

  res = await get(put.icon!)
  assert.equal(res.status, 200)
  assert.equal(res.headers.get('content-type'), 'image/png')
  assert.equal(res.headers.get('cache-control'), 'private, max-age=31536000, immutable', 'v が合っていれば長くキャッシュ')
  assert.deepEqual(new Uint8Array(await res.arrayBuffer()), PNG)
  res = await get('/api/sessions/C1%40r/icon')
  assert.equal(res.headers.get('cache-control'), 'no-store', 'v 無しはキャッシュしない')
  assert.equal((await fetch(`${base}${put.icon}`, { method: 'HEAD' })).status, 200)

  // 差し替え: 種類が変わっても同じ URL の形で、v が変わる
  await new Promise((r) => setTimeout(r, 15))
  res = await putIcon('C1@r', JPEG)
  const replaced = (await res.json()) as SessionIconResponse
  assert.notEqual(replaced.icon, put.icon)
  res = await get(replaced.icon!)
  assert.equal(res.headers.get('content-type'), 'image/jpeg')
  const replacedList = (await (await get('/api/sessions?days=7')).json()) as SessionsResponse
  assert.notEqual(replacedList.rev, updated.rev)

  res = await deleteIcon('C1@r')
  assert.equal(res.status, 200)
  assert.deepEqual(await res.json(), { id: 'C1@r', icon: null })
  assert.equal((await get('/api/sessions/C1%40r/icon')).status, 404)
  const gone = (await (await get('/api/sessions?days=7')).json()) as SessionsResponse
  assert.equal(gone.sessions.find((s) => s.id === 'C1@r')!.icon, undefined)
  assert.equal((await deleteIcon('C1@r')).status, 200, '無くても消せる')
})

test('PUT icon: 検査。画像でない・空・大きすぎる・窓に無いセッション', async () => {
  const bad = async (id: string, body: string | Uint8Array, status: number, re: RegExp) => {
    const res = await putIcon(id, body)
    assert.equal(res.status, status)
    assert.match(((await res.json()) as { error: string }).error, re)
  }
  await bad('C1@r', new Uint8Array([1, 2, 3, 4, 5]), 400, /画像ファイル/)
  await bad('C1@r', '<svg xmlns="http://www.w3.org/2000/svg"></svg>', 400, /画像ファイル/)
  await bad('C1@r', new Uint8Array(0), 400, /空/)
  await bad('C1@r', new Uint8Array(1024 * 1024 + 1), 413, /1MB/)
  await bad('nope@r', PNG, 404, /not found/)
  assert.equal((await putIcon('', PNG)).status, 400, 'id が空')
  assert.equal((await get('/api/sessions/C1%40r/icon')).status, 404, '何も置かれていない')
})

test('PUT/DELETE icon: 別オリジンは 403、メソッド違いは 405', async () => {
  const host = base.replace('http://', '')
  assert.equal((await putIcon('C1@r', PNG, { Origin: 'http://evil.local:8787' })).status, 403)
  assert.equal((await putIcon('C1@r', PNG, { 'Sec-Fetch-Site': 'cross-site' })).status, 403)
  assert.equal((await deleteIcon('C1@r', { Origin: 'http://evil.local:8787' })).status, 403)
  assert.equal((await putIcon('C1@r', PNG, { Origin: `http://${host}`, 'Sec-Fetch-Site': 'same-origin' })).status, 200)
  await deleteIcon('C1@r')
  assert.equal((await fetch(`${base}/api/sessions/C1%40r/icon`, { method: 'POST' })).status, 405)
  assert.equal((await fetch(`${base}/api/sessions/C1%40r/meta`, { method: 'DELETE' })).status, 405, 'DELETE はアイコンだけ')
})

test('PUT meta: archived_at でアーカイブ。一覧とフィードから消え、archived=1 で出て、新しい行が届くと自動で戻る', async () => {
  const initial = (await (await get('/api/sessions?days=7')).json()) as SessionsResponse
  assert.ok(initial.sessions.some((s) => s.id === 'S2@sai'))
  assert.equal(initial.total, 6)
  assert.equal(((await (await get('/api/feed?days=3&repo=sai')).json()) as FeedResponse).rows.length, 1)

  // 名前を付けてからアーカイブしても名前は残る（PUT は重ねる）
  await putMeta('S2@sai', { name: '終わった' })
  const at = new Date().toISOString()
  let res = await putMeta('S2@sai', { archived_at: at })
  assert.equal(res.status, 200)
  assert.deepEqual(((await res.json()) as SessionMetaResponse).meta, { name: '終わった', archived_at: at })

  const list = (await (await get('/api/sessions?days=7')).json()) as SessionsResponse
  assert.notEqual(list.rev, initial.rev, 'アーカイブしただけでも rev が変わる')
  assert.ok(!list.sessions.some((s) => s.id === 'S2@sai'), '既定ではアーカイブ済みは出ない')
  assert.equal(list.total, 5, 'total もアーカイブ済みを除く')
  assert.deepEqual(list.filters.repos, ['kanban', 'r'], 'filters もアーカイブ済みを除いた集合から')

  const arch = (await (await get('/api/sessions?days=7&archived=1')).json()) as SessionsResponse
  assert.deepEqual(arch.sessions.map((s) => [s.id, s.archived]), [['S2@sai', true]])
  assert.equal(arch.total, 1)

  const detail = (await (await get('/api/sessions/S2%40sai')).json()) as SessionDetailResponse
  assert.equal(detail.session.archived, true, '直接開けば読める')
  assert.equal(detail.rows.length, 1)

  const feed = (await (await get('/api/feed?days=3&repo=sai')).json()) as FeedResponse
  assert.equal(feed.rows.length, 0, 'フィードにも流れない')
  assert.equal(((await (await get('/api/feed?days=3')).json()) as FeedResponse).rows.length, 6)

  // 新しい行が届くと、メタを書き換えずに戻る
  const later = new Date(Date.now() + 1000)
  await appendFile(join(feedDir, `${localDate(later.toISOString())}.jsonl`), JSON.stringify(row(later, 'S2', { agent: 'codex', repo: 'sai', text: 'again' })) + '\n')
  const back = (await (await get('/api/sessions?days=7')).json()) as SessionsResponse
  const s2 = back.sessions.find((s) => s.id === 'S2@sai')!
  assert.ok(s2, '一覧に戻る')
  assert.equal(s2.archived, undefined)
  assert.deepEqual(s2.meta, { name: '終わった', archived_at: at }, 'メタはそのまま')
  assert.equal(((await (await get('/api/sessions?days=7&archived=1')).json()) as SessionsResponse).sessions.length, 0)
  assert.equal(((await (await get('/api/feed?days=3&repo=sai')).json()) as FeedResponse).rows.length, 2)

  // 戻す = archived_at を消す。名前は残る
  res = await putMeta('S2@sai', { archived_at: '' })
  assert.deepEqual(((await res.json()) as SessionMetaResponse).meta, { name: '終わった' })
  await putMeta('S2@sai', { name: '' })
  assert.deepEqual(JSON.parse(await readFile(join(feedDir, 'session-meta.json'), 'utf-8')), {})

  // 検査
  assert.equal((await putMeta('S2@sai', { archived_at: 'yesterday' })).status, 400)
  assert.equal((await putMeta('S2@sai', { archived_at: 1 })).status, 400)
})

test('GET/PUT /api/settings: 性格。知らない値は 400、別オリジンは 403、ファイルに残る', async () => {
  let res = await get('/api/settings')
  assert.equal(res.status, 200)
  let data = (await res.json()) as SettingsResponse
  assert.deepEqual(data, { persona: 'ENFP', digest: true, model: 'fake' }, '既定は ENFP。digest はテストでは有効')
  const put = (body: unknown, headers: Record<string, string> = {}) =>
    fetch(`${base}/api/settings`, { method: 'PUT', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) })
  res = await put({ persona: 'ISTJ' })
  assert.equal(res.status, 200)
  data = (await res.json()) as SettingsResponse
  assert.equal(data.persona, 'ISTJ')
  assert.equal(((await (await get('/api/settings')).json()) as SettingsResponse).persona, 'ISTJ')
  assert.deepEqual(JSON.parse(await readFile(join(feedDir, 'settings.json'), 'utf-8')), { persona: 'ISTJ' })
  assert.equal((await put({ persona: 'XXXX' })).status, 400)
  assert.equal((await put({ persona: 1 })).status, 400)
  assert.equal((await put('nope')).status, 400)
  assert.equal((await put({ persona: 'ENFP' }, { Origin: 'http://evil.local' })).status, 403)
  assert.equal((await fetch(`${base}/api/settings`, { method: 'POST' })).status, 405)
  await put({ persona: 'none' })
})

test('digest: 起動後に増えた行に一言が付いて feed / 詳細 / 一覧に載り、rev が変わる。backfill は既にあった行も積む', async () => {
  const now = new Date()
  const feedBefore = (await (await get('/api/feed?days=3')).json()) as FeedResponse
  // 起動時（最初の /api の応答）にあった行には付かない。前のテストが追記した行は「起動後に増えた行」なので付いていてよい
  assert.equal(feedBefore.rows.find((r) => r.session === 'S1' && r.text === 'hi')!.summary, undefined, '起動時にあった行には付かない')
  const promptsBefore = summarizer.prompts.length
  const withBefore = feedBefore.rows.filter((r) => r.summary).length

  // 新しい行が届く → 次の応答のついでに列に積まれ、直列で作られる
  const path = join(feedDir, `${localDate(now.toISOString())}.jsonl`)
  const ts = new Date(now.getTime() + 2000)
  await appendFile(path, JSON.stringify(row(ts, 'D1', { repo: 'r', text: 'PR #35 をマージしました。次は #31 です。', user_text: 'マージして' })) + '\n')
  await get('/api/feed?days=3')
  await digester.drain()
  assert.equal(summarizer.prompts.length, promptsBefore + 1)
  const prompt = summarizer.prompts[summarizer.prompts.length - 1]!
  assert.match(prompt, /PR #35 をマージしました/)
  assert.match(prompt, /口調: /)

  const feedAfter = (await (await get('/api/feed?days=3')).json()) as FeedResponse
  const d1 = feedAfter.rows.find((r) => r.session === 'D1')!
  assert.equal(d1.summary, '一言: PR #35 を')
  assert.notEqual(feedAfter.rev, feedBefore.rev)
  assert.equal(feedAfter.rows.find((r) => r.session === 'S1' && r.text === 'hi')!.summary, undefined)

  const detail = (await (await get('/api/sessions/D1%40r')).json()) as SessionDetailResponse
  assert.equal(detail.rows[0]!.summary, '一言: PR #35 を')
  assert.equal(detail.session.last_summary, '一言: PR #35 を')
  const list = (await (await get('/api/sessions?days=7')).json()) as SessionsResponse
  assert.equal(list.sessions.find((s) => s.id === 'D1@r')!.last_summary, '一言: PR #35 を')
  assert.equal(list.sessions.find((s) => s.id === 'S1@kanban')!.last_summary, undefined, '起動時にあった行しか無いセッションには付かない')

  // ファイルに残っている（作ったときの性格つき）
  const saved = (await readFile(join(feedDir, 'digest.jsonl'), 'utf-8')).trim().split('\n').map((l) => JSON.parse(l) as { key: string; persona: string; summary: string })
  const mine = saved.find((e) => e.key.startsWith('D1@r|'))!
  assert.ok(mine)
  assert.equal(mine.persona, 'none')
  assert.equal(mine.summary, '一言: PR #35 を')

  // backfill: 起動時にあった行も、まだ無いものを新しい順に n 件
  const bf = await fetch(`${base}/api/digest/backfill?n=2&days=7`, { method: 'POST' })
  assert.equal(bf.status, 202)
  assert.deepEqual(await bf.json(), { queued: 2 } satisfies DigestBackfillResponse)
  await digester.drain()
  const after = (await (await get('/api/feed?days=3')).json()) as FeedResponse
  assert.equal(after.rows.filter((r) => r.summary).length, withBefore + 1 + 2, '前からあった分 + D1 + backfill の 2 件')
  assert.equal((await fetch(`${base}/api/digest/backfill?n=1`, { method: 'POST', headers: { Origin: 'http://evil.local' } })).status, 403)
  assert.equal((await fetch(`${base}/api/digest/backfill`, { method: 'GET' })).status, 405)

  // 失敗した行は無いまま（画面は本文を出す）
  summarizer.fail = true
  await appendFile(path, JSON.stringify(row(new Date(now.getTime() + 3000), 'D1', { repo: 'r', text: '失敗する' })) + '\n')
  await get('/api/feed?days=3')
  await digester.drain()
  summarizer.fail = false
  const failed = (await (await get('/api/feed?days=3')).json()) as FeedResponse
  assert.equal(failed.rows.find((r) => r.text === '失敗する')!.summary, undefined)
})

test('replyCommand は SAI_*_BIN で実行ファイルを差し替えられる', () => {
  assert.deepEqual(replyCommand('claude', 'S', 'hi', '/w', {}), { bin: 'claude', args: ['-p', '--resume', 'S', '--', 'hi'], cwd: '/w', text: 'hi' })
  assert.deepEqual(replyCommand('codex', 'S', 'hi', '/w', {})!.args, ['exec', 'resume', 'S', '--', 'hi'])
  assert.equal(replyCommand('claude', 'S', 'hi', '/w', { SAI_CLAUDE_BIN: '/opt/claude' })!.bin, '/opt/claude')
  assert.equal(replyCommand('codex', 'S', 'hi', '/w', { SAI_CODEX_BIN: '/opt/codex' })!.bin, '/opt/codex')
  assert.equal(replyCommand('unknown', 'S', 'hi', '/w', {}), null)
})

test('replyCommand は本文が - で始まってもフラグにならない（-- の後ろに置く）', () => {
  // `claude -p --resume S "--version"` は版を出して終わり、`codex exec resume S "--help"` はヘルプを出す。`--` で区切ると本文になる
  for (const text of ['--version', '-h', '--dangerously-skip-permissions']) {
    const c = replyCommand('claude', 'S', text, '/w', {})!
    assert.equal(c.args[c.args.length - 1], text)
    assert.equal(c.args[c.args.length - 2], '--')
    const x = replyCommand('codex', 'S', text, '/w', {})!
    assert.deepEqual(x.args.slice(-2), ['--', text])
  }
})

test('replyCommand: SAI_*_ARGS の追加引数。Claude は先頭（--allowedTools が本文を飲まないように）、Codex は resume の直後', () => {
  assert.deepEqual(
    replyCommand('claude', 'S', 'gh pr create', '/w', { SAI_CLAUDE_ARGS: '--allowedTools "Bash(gh *)" --permission-mode acceptEdits' })!.args,
    ['--allowedTools', 'Bash(gh *)', '--permission-mode', 'acceptEdits', '-p', '--resume', 'S', '--', 'gh pr create'],
  )
  assert.deepEqual(replyCommand('codex', 'S', 'hi', '/w', { SAI_CODEX_ARGS: '-s workspace-write' })!.args, ['exec', 'resume', '-s', 'workspace-write', 'S', '--', 'hi'])
  assert.deepEqual(replyCommand('claude', 'S', 'hi', '/w', { SAI_CLAUDE_ARGS: '   ' })!.args, ['-p', '--resume', 'S', '--', 'hi'], '空白だけなら何も足さない')
})

test('splitArgs: シェル風に割る', () => {
  assert.deepEqual(splitArgs(undefined), [])
  assert.deepEqual(splitArgs(''), [])
  assert.deepEqual(splitArgs('  a   b  '), ['a', 'b'])
  assert.deepEqual(splitArgs('--allowedTools "Bash(gh *)" Edit'), ['--allowedTools', 'Bash(gh *)', 'Edit'])
  assert.deepEqual(splitArgs("--allowedTools 'Bash(git *) Edit'"), ['--allowedTools', 'Bash(git *) Edit'])
  assert.deepEqual(splitArgs('a\\ b "c \\" d" ""'), ['a b', 'c " d', ''], 'バックスラッシュと空の引用')
  assert.deepEqual(splitArgs('--model=x --flag'), ['--model=x', '--flag'])
})

test('store.rows: cwd がフィードのディレクトリ（SAI 自身が回した子）の行は読み飛ばす', async () => {
  const d = await mkdtemp(join(tmpdir(), 'sai-own-'))
  try {
    const now = new Date()
    const lines = [
      row(new Date(now.getTime() - min(3)), 'real', { cwd: '/home/u/kanban' }),
      row(new Date(now.getTime() - min(2)), 'child', { cwd: d, text: '一言' }),
      row(new Date(now.getTime() - min(1)), 'child2', { cwd: join(d, 'sub'), text: '一言' }),
    ]
    await writeFile(join(d, `${localDate(now.toISOString())}.jsonl`), lines.map((l) => JSON.stringify(l)).join('\n') + '\n')
    const s = new FeedStore(d)
    assert.deepEqual((await s.rows(7)).map((r) => r.session), ['real'])
    assert.deepEqual((await s.sessions(7)).sessions.map((x) => x.id), ['real@kanban'])
  } finally {
    await rm(d, { recursive: true, force: true })
  }
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

// -- 返信中の許可・質問（approvals）

const postJson = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) })

test('approvals: 返信を処理中のセッションの分だけ預かり、一覧・詳細・フィードに載って rev が変わる', async () => {
  // 処理中でなければ受けない
  let res = await postJson('/api/approvals', { id: 'C1@r', tool_name: 'Bash', input: { command: 'gh pr create' } })
  assert.equal(res.status, 409)

  runner.busy.set('C1@r', { since: new Date().toISOString(), text: 'やって' })
  const prev = ((await (await get('/api/sessions?days=30')).json()) as SessionsResponse).rev
  res = await postJson('/api/approvals', { id: 'C1@r', tool_name: 'Bash', input: { command: 'gh pr create', description: 'PR' }, tool_use_id: 't1' })
  assert.equal(res.status, 201)
  const { approval_id } = (await res.json()) as { approval_id: string }
  assert.ok(approval_id)

  const list = (await (await get('/api/sessions?days=30')).json()) as SessionsResponse
  assert.notEqual(list.rev, prev, '答え待ちが増えたら rev が変わる（JSONL は変わっていない）')
  assert.equal(list.approvals['C1@r']?.length, 1)
  assert.equal(list.approvals['C1@r']![0]!.text, '許可待ち: Bash: gh pr create')
  assert.equal(list.approvals['C1@r']![0]!.tool_use_id, 't1')
  const detail = (await (await get('/api/sessions/C1%40r?days=30')).json()) as SessionDetailResponse
  assert.equal(detail.approvals['C1@r']?.[0]?.approval_id, approval_id)
  const feed = (await (await get('/api/feed?days=30')).json()) as FeedResponse
  assert.equal(feed.approvals['C1@r']?.[0]?.approval_id, approval_id)

  // まだ答えが無い: wait 無しなら即 202
  res = await get(`/api/approvals/${approval_id}`)
  assert.equal(res.status, 202)

  // 別オリジンからは答えられない（ここが通ると CSRF で許可が押せる）
  res = await postJson(`/api/approvals/${approval_id}/answer`, { behavior: 'allow' }, { Origin: 'http://evil.example' })
  assert.equal(res.status, 403)
  res = await postJson(`/api/approvals/${approval_id}/answer`, { behavior: 'maybe' })
  assert.equal(res.status, 400)

  // 画面から許可 → MCP 側の取りに来た分に決定が渡り、一覧からは消える
  res = await postJson(`/api/approvals/${approval_id}/answer`, { behavior: 'allow' }, { Origin: base })
  assert.equal(res.status, 200)
  res = await get(`/api/approvals/${approval_id}?wait=1`)
  assert.equal(res.status, 200)
  assert.deepEqual(await res.json(), { behavior: 'allow', updatedInput: { command: 'gh pr create', description: 'PR' } }, 'updatedInput を省けば元の入力')
  assert.equal((await get(`/api/approvals/${approval_id}`)).status, 404, '渡したら消える')
  const next = (await (await get('/api/sessions?days=30')).json()) as SessionsResponse
  assert.equal(next.approvals['C1@r'], undefined)
  assert.equal((await postJson(`/api/approvals/${approval_id}/answer`, { behavior: 'deny' }, { Origin: base })).status, 404)

  // 拒否は message 付きで届く
  res = await postJson('/api/approvals', { id: 'C1@r', tool_name: 'Edit', input: { file_path: '/x' } })
  const second = ((await res.json()) as { approval_id: string }).approval_id
  assert.equal((await postJson(`/api/approvals/${second}/answer`, { behavior: 'deny', message: 'だめ' }, { Origin: base })).status, 200)
  assert.deepEqual(await (await get(`/api/approvals/${second}`)).json(), { behavior: 'deny', message: 'だめ' })
  runner.busy.delete('C1@r')
})

test('approvals: 常に許可（remember: local）はサーバがルールを組み立てて updatedPermissions で CLI に渡す', async () => {
  runner.busy.set('C1@r', { since: new Date().toISOString(), text: 'やって' })
  let res = await postJson('/api/approvals', { id: 'C1@r', tool_name: 'Bash', input: { command: 'gh pr create --fill', description: 'PR' } })
  const bash = ((await res.json()) as { approval_id: string }).approval_id
  res = await postJson(`/api/approvals/${bash}/answer`, { behavior: 'allow', remember: 'local' }, { Origin: base })
  assert.equal(res.status, 200)
  assert.equal(((await res.json()) as { remembered?: string }).remembered, 'Bash(gh pr:*)')
  assert.deepEqual(await (await get(`/api/approvals/${bash}`)).json(), {
    behavior: 'allow',
    updatedInput: { command: 'gh pr create --fill', description: 'PR' },
    updatedPermissions: [{ type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'gh pr:*' }], behavior: 'allow', destination: 'localSettings' }],
  })

  // 画面がルールを送っても無視して、サーバが組み立てたものになる
  res = await postJson('/api/approvals', { id: 'C1@r', tool_name: 'Bash', input: { command: 'mkdir x' } })
  const forged = ((await res.json()) as { approval_id: string }).approval_id
  res = await postJson(
    `/api/approvals/${forged}/answer`,
    { behavior: 'allow', remember: 'local', updatedPermissions: [{ type: 'addRules', rules: [{ toolName: 'Bash' }], behavior: 'allow', destination: 'userSettings' }] },
    { Origin: base },
  )
  assert.equal(res.status, 200)
  const forgedAnswer = (await (await get(`/api/approvals/${forged}`)).json()) as { updatedPermissions: unknown[] }
  assert.deepEqual(forgedAnswer.updatedPermissions, [{ type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'mkdir:*' }], behavior: 'allow', destination: 'localSettings' }])

  // 「常に」が無いツール（Edit / AskUserQuestion）は 400。deny に remember を付けても何も起きない
  res = await postJson('/api/approvals', { id: 'C1@r', tool_name: 'Edit', input: { file_path: '/x' } })
  const edit = ((await res.json()) as { approval_id: string }).approval_id
  res = await postJson(`/api/approvals/${edit}/answer`, { behavior: 'allow', remember: 'local' }, { Origin: base })
  assert.equal(res.status, 400)
  assert.match(((await res.json()) as { error: string }).error, /常に許可/)
  assert.equal((await postJson(`/api/approvals/${edit}/answer`, { behavior: 'allow', remember: 'forever' }, { Origin: base })).status, 400, '知らない remember')
  assert.equal((await postJson(`/api/approvals/${edit}/answer`, { behavior: 'deny', remember: 'local' }, { Origin: base })).status, 200)
  assert.deepEqual(await (await get(`/api/approvals/${edit}`)).json(), { behavior: 'deny', message: 'SAI の画面で拒否された' })
  runner.busy.delete('C1@r')
})

test('approvals: 不正な body と無い id', async () => {
  runner.busy.set('C1@r', { since: new Date().toISOString(), text: 'やって' })
  assert.equal((await postJson('/api/approvals', { id: 'C1@r', tool_name: 'Bash' })).status, 400, 'input が無い')
  assert.equal((await postJson('/api/approvals', { tool_name: 'Bash', input: {} })).status, 400, 'id が無い')
  assert.equal((await postJson('/api/approvals', { id: 'C1@r', tool_name: 'Bash', input: {} }, { Origin: 'http://evil.example' })).status, 403)
  assert.equal((await get('/api/approvals/nope')).status, 404)
  assert.equal((await postJson('/api/approvals/nope/answer', { behavior: 'allow' }, { Origin: base })).status, 404)
  assert.equal((await fetch(base + '/api/approvals', { method: 'PUT' })).status, 405)
  runner.busy.delete('C1@r')
})

test('replyCommand: approve を渡すと Claude だけに --mcp-config と --permission-prompt-tool が付く', () => {
  const via = { url: 'http://127.0.0.1:8787', entity: 'S@r' }
  const c = replyCommand('claude', 'S', 'hi', '/w', {}, via)!
  assert.deepEqual(c.args.slice(2), ['--permission-prompt-tool', 'mcp__sai__approve', '-p', '--resume', 'S', '--', 'hi'])
  assert.equal(c.args[0], '--mcp-config')
  assert.deepEqual(JSON.parse(c.args[1]!).mcpServers.sai.env, { SAI_URL: 'http://127.0.0.1:8787', SAI_ENTITY: 'S@r' })
  // 運用者の引数は先頭のまま。--mcp-config は可変長なので、直後がフラグ（--permission-prompt-tool）である並び
  const withExtra = replyCommand('claude', 'S', 'hi', '/w', { SAI_CLAUDE_ARGS: '--allowedTools "Bash(gh *)"' }, via)!
  assert.deepEqual(withExtra.args.slice(0, 3), ['--allowedTools', 'Bash(gh *)', '--mcp-config'])
  // 外す: SAI_APPROVE=0、または運用者が自前の --permission-prompt-tool を持っている
  assert.deepEqual(replyCommand('claude', 'S', 'hi', '/w', { SAI_APPROVE: '0' }, via)!.args, ['-p', '--resume', 'S', '--', 'hi'])
  const own = replyCommand('claude', 'S', 'hi', '/w', { SAI_CLAUDE_ARGS: '--permission-prompt-tool mcp__x__y' }, via)!
  assert.equal(own.args.filter((a) => a === '--permission-prompt-tool').length, 1)
  assert.equal(own.args.includes('--mcp-config'), false)
  // approve 無し・Codex には何も付かない
  assert.deepEqual(replyCommand('claude', 'S', 'hi', '/w', {})!.args, ['-p', '--resume', 'S', '--', 'hi'])
  assert.deepEqual(replyCommand('codex', 'S', 'hi', '/w', {}, via)!.args, ['exec', 'resume', 'S', '--', 'hi'])
})

// -- 自分の表示名とアイコン（profile）

test('profile: 表示名を置くと一覧・詳細・フィードの profile に載り、rev が変わり、空で消える', async () => {
  const prev = (await (await get('/api/sessions?days=30')).json()) as SessionsResponse
  assert.deepEqual(prev.profile, {}, '何も付けていなければ空')
  assert.deepEqual(await (await get('/api/profile')).json(), { profile: {} })

  let res = await fetch(base + '/api/profile', { method: 'PUT', headers: { 'Content-Type': 'application/json', Origin: base }, body: JSON.stringify({ name: '  Jesse  ' }) })
  assert.equal(res.status, 200)
  assert.deepEqual(await res.json(), { profile: { name: 'Jesse' } }, '空白は詰める')

  const list = (await (await get('/api/sessions?days=30')).json()) as SessionsResponse
  assert.deepEqual(list.profile, { name: 'Jesse' })
  assert.notEqual(list.rev, prev.rev, '名前を付けただけで rev が変わる（JSONL は変わっていない）')
  assert.deepEqual(((await (await get('/api/sessions/S1%40kanban?days=30')).json()) as SessionDetailResponse).profile, { name: 'Jesse' })
  assert.deepEqual(((await (await get('/api/feed?days=30')).json()) as FeedResponse).profile, { name: 'Jesse' })
  assert.match(await readFile(join(feedDir, 'profile.json'), 'utf-8'), /"name": "Jesse"/)

  // 検査。長すぎ・文字列でない
  res = await fetch(base + '/api/profile', { method: 'PUT', headers: { 'Content-Type': 'application/json', Origin: base }, body: JSON.stringify({ name: 'x'.repeat(101) }) })
  assert.equal(res.status, 400)
  res = await fetch(base + '/api/profile', { method: 'PUT', headers: { 'Content-Type': 'application/json', Origin: base }, body: JSON.stringify({ name: 1 }) })
  assert.equal(res.status, 400)
  // 空で消す
  res = await fetch(base + '/api/profile', { method: 'PUT', headers: { 'Content-Type': 'application/json', Origin: base }, body: JSON.stringify({ name: '' }) })
  assert.deepEqual(await res.json(), { profile: {} })
})

test('profile icon: 画像を置くと profile.icon に URL が載り、GET で返り、DELETE で消える', async () => {
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64')
  const prev = ((await (await get('/api/sessions?days=30')).json()) as SessionsResponse).rev
  let res = await fetch(base + '/api/profile/icon', { method: 'PUT', headers: { Origin: base }, body: png })
  assert.equal(res.status, 200)
  const { profile } = (await res.json()) as { profile: { icon?: string; name?: string } }
  assert.match(profile.icon ?? '', /^\/api\/profile\/icon\?v=/)
  assert.equal(profile.name, undefined)

  res = await get(profile.icon!)
  assert.equal(res.status, 200)
  assert.equal(res.headers.get('content-type'), 'image/png')
  assert.match(res.headers.get('cache-control') ?? '', /immutable/)
  const list = (await (await get('/api/sessions?days=30')).json()) as SessionsResponse
  assert.equal(list.profile.icon, profile.icon)
  assert.notEqual(list.rev, prev)
  // セッションの一覧には混ざらない（固定の鍵 me はエンティティ ID ではない）
  assert.equal(list.sessions.some((s) => s.icon === profile.icon), false)

  // 画像でないもの、空
  assert.equal((await fetch(base + '/api/profile/icon', { method: 'PUT', headers: { Origin: base }, body: 'not an image' })).status, 400)
  assert.equal((await fetch(base + '/api/profile/icon', { method: 'PUT', headers: { Origin: base }, body: '' })).status, 400)

  res = await fetch(base + '/api/profile/icon', { method: 'DELETE', headers: { Origin: base } })
  assert.deepEqual(await res.json(), { profile: {} })
  assert.equal((await get('/api/profile/icon')).status, 404)
})

test('profile: 別オリジンは 403、メソッド違いは 405', async () => {
  const evil = { Origin: 'http://evil.example', 'Content-Type': 'application/json' }
  assert.equal((await fetch(base + '/api/profile', { method: 'PUT', headers: evil, body: '{"name":"x"}' })).status, 403)
  assert.equal((await fetch(base + '/api/profile/icon', { method: 'PUT', headers: { Origin: 'http://evil.example' }, body: 'x' })).status, 403)
  assert.equal((await fetch(base + '/api/profile/icon', { method: 'DELETE', headers: { Origin: 'http://evil.example' } })).status, 403)
  assert.equal((await fetch(base + '/api/profile', { method: 'POST', headers: evil, body: '{}' })).status, 405)
  assert.equal((await fetch(base + '/api/profile', { method: 'DELETE', headers: evil })).status, 405)
})

test('GET /api/sessions は record_version を返す（fixture は v 無し = 1）', async () => {
  const data = (await (await get('/api/sessions?days=30')).json()) as SessionsResponse
  assert.equal(data.record_version, 1)
})
