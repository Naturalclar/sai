import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import type { Server } from 'node:http'
import { mkdtemp, rm, writeFile, appendFile, mkdir, stat, utimes, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Replying, ReplyResponse, SessionsResponse, SessionDetailResponse, SessionMetaResponse, FeedResponse } from '../shared/types.ts'
import { createApp, parseDays, revWith } from './app.ts'
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
    JSON.stringify(row(new Date(now.getTime() - min(5)), 'S1', { text: 'two', user_text: '続きの題名' })),
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

test('PUT meta: 表示名とアイコンが一覧と詳細に載り、rev が変わり、ファイルに残る', async () => {
  const initial = (await (await get('/api/sessions?days=7')).json()) as SessionsResponse
  assert.equal(initial.sessions.find((s) => s.id === 'C1@r')!.meta, undefined)

  let res = await putMeta('C1@r', { name: '  README  直し\n', icon: ' 🧪 ' })
  assert.equal(res.status, 200)
  let data = (await res.json()) as SessionMetaResponse
  assert.deepEqual(data, { id: 'C1@r', meta: { name: 'README 直し', icon: '🧪' } }, '空白は詰め、前後は落とす')

  const updated = (await (await get('/api/sessions?days=7')).json()) as SessionsResponse
  assert.notEqual(updated.rev, initial.rev, '名前を付けただけでも rev が変わる（画面のポーリングが拾う）')
  assert.deepEqual(updated.sessions.find((s) => s.id === 'C1@r')!.meta, { name: 'README 直し', icon: '🧪' })
  assert.equal(updated.sessions.find((s) => s.id === 'X1@r')!.meta, undefined, '他のセッションには付かない')
  assert.equal(
    updated.sessions.find((s) => s.id === 'C1@r')!.title,
    initial.sessions.find((s) => s.id === 'C1@r')!.title,
    'title は元のまま（画面側で出し分ける）',
  )
  const detail = (await (await get('/api/sessions/C1%40r')).json()) as SessionDetailResponse
  assert.deepEqual(detail.session.meta, { name: 'README 直し', icon: '🧪' })
  res = await get('/api/sessions/C1%40r/meta')
  assert.deepEqual(await res.json(), { id: 'C1@r', meta: { name: 'README 直し', icon: '🧪' } })

  const file = JSON.parse(await readFile(join(feedDir, 'session-meta.json'), 'utf-8')) as Record<string, unknown>
  assert.deepEqual(file, { 'C1@r': { name: 'README 直し', icon: '🧪' } })

  // 省略したキーは据え置き。名前だけ消す → icon だけ残る。両方消す → エントリごと消える
  res = await putMeta('C1@r', { icon: '🧪' })
  assert.deepEqual(((await res.json()) as SessionMetaResponse).meta, { name: 'README 直し', icon: '🧪' }, 'name は省略なので残る')
  res = await putMeta('C1@r', { name: '' })
  assert.deepEqual(((await res.json()) as SessionMetaResponse).meta, { icon: '🧪' })
  res = await putMeta('C1@r', { name: '', icon: '' })
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
  await bad({ icon: '🧪🧪' }, /絵文字1つ/)
  await bad({ icon: 'ab' }, /絵文字1つ/)
  await bad({ name: 'x'.repeat(101) }, /100 文字/)
  await bad({ name: 1 }, /文字列/)
  await bad('not json', /JSON|Unexpected|token/i)
  await bad([1], /オブジェクト/)
  assert.equal((await putMeta('C1@r', { name: 'x'.repeat(5 * 1024) })).status, 400, '大きすぎる body')
  assert.equal((await putMeta('nope@r', { name: 'x' })).status, 404, '窓の中に無いセッションには付けない')
  assert.equal((await putMeta('', { name: 'x' })).status, 400, 'id が空')
  // ZWJ で繋いだ絵文字は1文字として通る
  const res = await putMeta('C1@r', { icon: '👨‍👩‍👧' })
  assert.equal(res.status, 200)
  await putMeta('C1@r', { name: '', icon: '' }) // PUT は重ねる意味なので {} では消えない
})

test('PUT meta: 別オリジンは 403、メソッド違いは 405', async () => {
  const host = base.replace('http://', '')
  assert.equal((await putMeta('C1@r', { name: 'x' }, { Origin: 'http://evil.local:8787' })).status, 403)
  assert.equal((await putMeta('C1@r', { name: 'x' }, { 'Sec-Fetch-Site': 'cross-site' })).status, 403)
  assert.equal((await putMeta('C1@r', { name: 'x' }, { Origin: `http://${host}`, 'Sec-Fetch-Site': 'same-origin' })).status, 200)
  await putMeta('C1@r', { name: '', icon: '' }) // PUT は重ねる意味なので {} では消えない
  assert.equal((await fetch(`${base}/api/sessions/C1%40r/meta`, { method: 'POST' })).status, 405)
  assert.equal((await fetch(`${base}/api/sessions/C1%40r/reply`, { method: 'PUT' })).status, 405)
  assert.equal((await fetch(`${base}/api/sessions`, { method: 'PUT' })).status, 405)
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

test('replyCommand は SAI_*_BIN で実行ファイルを差し替えられる', () => {
  assert.deepEqual(replyCommand('claude', 'S', 'hi', '/w', {}), { bin: 'claude', args: ['-p', '--resume', 'S', 'hi'], cwd: '/w', text: 'hi' })
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
