// tailnet から MCP で呼ぶ口（`/mcp`。#312 の A）を、本物の createApp に叩かせる。
// 身元は whois を差し替えて作る（ユーザーの端末 / capability を与えたユーザー / タグ付きの端末）
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import type { Server } from 'node:http'
import { appendFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AGENT_TEXT_MAX_CHARS, deliveredFromTailnet } from '../../shared/agentMessages.ts'
import { DEFAULT_PORT } from '../../shared/port.ts'
import type { Replying } from '../../shared/types.ts'
import { createApp } from '../app.ts'
import { Approvals } from '../approvals/approvals.ts'
import { Authenticator } from '../auth.ts'
import type { WhoisInfo } from '../auth.ts'
import { BuildFreshness } from '../local/buildFreshness.ts'
import { ProgressReader } from '../local/progress.ts'
import type { CodexApp } from '../reply/codexAppServer.ts'
import type { ReplyCommand, Runner } from '../reply/runner.ts'
import { localDate } from '../rows/aggregate.ts'
import { row } from '../rows/aggregate.test.ts'
import { FeedStore } from '../rows/store.ts'
import { MCP_CAP } from './access.ts'
import { MCP_SEND_MAX } from './sendLimit.ts'

let dir: string
let work: string
let server: Server
let base: string
let feedFile: string

class FakeRunner implements Runner {
  started: { id: string; cmd: ReplyCommand }[] = []
  busy = new Map<string, Replying>()
  running(id: string) {
    const r = this.busy.get(id)
    return r !== undefined && !r.failed
  }
  snapshot() {
    return Object.fromEntries(this.busy)
  }
  async start(id: string, cmd: ReplyCommand) {
    this.started.push({ id, cmd })
  }
}
const runner = new FakeRunner()
const codexApp: CodexApp = {
  running: () => false,
  replying: () => ({}),
  snapshot: () => ({}),
  getApproval: () => undefined,
  async start() {},
  answer: () => ({ ok: false, status: 404, error: 'approval not found' }),
}

const DASH = 'https://dash.example.ts.net'
const whois: Record<string, WhoisInfo> = {
  '100.64.0.1': { login: 'me@example.com', tagged: false, node: 'phone', caps: {} },
  '100.64.0.2': { login: 'me@example.com', tagged: false, node: 'laptop', caps: { [MCP_CAP]: [{ tools: ['send'], origins: [DASH] }] } },
  '100.64.0.3': { login: 'tagged-devices', tagged: true, node: 'ci', caps: {} },
  '100.64.0.4': { login: 'tagged-devices', tagged: true, node: 'ci', caps: { [MCP_CAP]: [{ tools: ['read'] }] } },
}
/** capability の無いユーザーの端末 */
const USER = { 'Tailscale-User-Login': 'me@example.com', 'X-Forwarded-For': '100.64.0.1' }
/** send と Origin を与えたユーザーの端末 */
const SENDER = { 'Tailscale-User-Login': 'me@example.com', 'X-Forwarded-For': '100.64.0.2' }
/** タグ付きの端末（Serve は identity ヘッダを付けない） */
const CI = { 'X-Forwarded-For': '100.64.0.3' }
const CI_READ = { 'X-Forwarded-For': '100.64.0.4' }

const now = new Date()
const minutesAgo = (n: number) => new Date(now.getTime() - n * 60_000)

before(async () => {
  process.env.AGENT_FEED_HOST = 'testmac'
  dir = await mkdtemp(join(tmpdir(), 'sai-mcp-'))
  work = await mkdtemp(join(tmpdir(), 'sai-mcp-work-'))
  feedFile = join(dir, `${localDate(now.toISOString())}.jsonl`)
  await writeFile(
    feedFile,
    [
      row(minutesAgo(9), 'A1', { repo: 'r', cwd: work, project: 'o/r', user_text: '実装して', text: '実装しました' }),
      row(minutesAgo(8), 'B1', { repo: 'r', cwd: work, project: 'o/r', user_text: 'レビューして', text: 'レビューしました' }),
      // Claude でないセッション（許可モードのフラグを渡す先が無い。#582）
      row(minutesAgo(8), 'K1', { repo: 'r', cwd: work, project: 'o/r', agent: 'codex', user_text: '見て', text: '見ました' }),
      row(minutesAgo(7), 'C1', { repo: 'r', cwd: work, project: 'o/other' }),
      row(minutesAgo(6), 'P1', { repo: 'r', cwd: work, project: 'o/r' }),
      row(minutesAgo(5), 'R1', { repo: 'r', cwd: work, project: 'o/r', host: 'mini' }),
      // C1 は許可を待って止まっている（#323。一覧の 1 行に待ちを出す）
      row(minutesAgo(4), 'C1', { repo: 'r', cwd: work, project: 'o/other', event: 'PermissionRequest', text: '許可待ち: Bash: ls\n2 行目', user_text: '' }),
    ]
      .map((r) => JSON.stringify(r))
      .join('\n') + '\n',
  )
  const app = createApp(
    new FeedStore(dir),
    join(dir, 'dist'),
    runner,
    new Approvals(),
    new BuildFreshness(join(dir, 'dist'), [], 0),
    undefined,
    new Authenticator(async (addr) => whois[addr] ?? null),
    { tmux: { run: async () => { throw new Error('unused') } }, ps: async () => '', codexApp },
    undefined,
    undefined,
    undefined,
    // 使用量も、この Mac の ~/.claude / ~/.codex は読まない（読むと手元の枠の使い方で送れたり送れなかったりする。#275）
    usage as never,
    // この Mac の transcript は読まない
    new ProgressReader(join(dir, 'claude-projects'), join(dir, 'codex-sessions')),
  )
  server = createServer((req, res) => void app(req, res))
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const addr = server.address()
  base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`
  // P1 は素通し（bypassPermissions）を選んだセッション
  const meta = await fetch(`${base}/api/sessions/P1%40r/meta`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ permission_mode: 'bypassPermissions' }) })
  assert.equal(meta.status, 200)
})

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
  await rm(dir, { recursive: true, force: true })
  await rm(work, { recursive: true, force: true })
})

const mcp = (body: unknown, headers: Record<string, string> = {}, method = 'POST') =>
  fetch(`${base}/mcp`, {
    method,
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...headers },
    ...(method === 'POST' ? { body: typeof body === 'string' ? body : JSON.stringify(body) } : {}),
  })
type ToolResult = { content: { text: string }[]; isError?: boolean }
const call = async (name: string, args: Record<string, unknown>, headers: Record<string, string> = {}): Promise<ToolResult & { text: string }> => {
  const res = await mcp({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }, headers)
  assert.equal(res.status, 200, `${name} の HTTP`)
  const result = ((await res.json()) as { result: ToolResult }).result
  return { ...result, text: result.content.map((c) => c.text).join('\n') }
}
const toolNames = async (headers: Record<string, string> = {}) => {
  const res = await mcp({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, headers)
  assert.equal(res.status, 200)
  return ((await res.json()) as { result: { tools: { name: string }[] } }).result.tools.map((t) => t.name).sort()
}
const READ_TOOLS = ['sai_progress', 'sai_session', 'sai_sessions']
/** ループバック（と tailnet のユーザー）に見えるもの。読むツールと、入力欄に案を置く sai_suggest（#565。送らない） */
const LOOPBACK_TOOLS = [...READ_TOOLS, 'sai_suggest'].sort()

test('Serve を通ったのに identity ヘッダの無いリクエスト（タグ付きの端末）は、ローカルの直アクセスにしない。画面・REST は 401（#312）', async () => {
  assert.equal((await fetch(`${base}/api/sessions?days=1`, { headers: CI })).status, 401, '前は 200 で一覧が返っていた')
  assert.equal((await fetch(`${base}/api/sessions?days=1`, { headers: CI_READ })).status, 401, 'capability があっても REST は使えない（MCP だけ）')
  assert.equal((await fetch(`${base}/api/sessions?days=1`, { headers: { 'X-Forwarded-For': '100.64.0.1' } })).status, 401, 'ユーザーの端末なのにヘッダが無い')
  assert.equal((await fetch(`${base}/api/sessions?days=1`)).status, 200, 'ヘッダがどちらも無いループバックは今までどおり')
  assert.equal((await fetch(`${base}/api/sessions?days=1`, { headers: USER })).status, 200)
})

test('/mcp: initialize は受ける版を返す。通知は 202。知らない MCP-Protocol-Version・配列・壊れた JSON は 400。GET / DELETE は 405', async () => {
  let res = await mcp({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } } })
  assert.equal(res.status, 200)
  assert.match(res.headers.get('content-type') ?? '', /application\/json/)
  const init = (await res.json()) as { result: { protocolVersion: string; serverInfo: { name: string } } }
  assert.equal(init.result.protocolVersion, '2025-06-18')
  assert.equal(init.result.serverInfo.name, 'sai')

  res = await mcp({ jsonrpc: '2.0', method: 'notifications/initialized' })
  assert.equal(res.status, 202)
  assert.equal(await res.text(), '')

  assert.equal((await mcp({ jsonrpc: '2.0', id: 1, method: 'ping' }, { 'MCP-Protocol-Version': '2024-11-05' })).status, 400)
  assert.equal((await mcp({ jsonrpc: '2.0', id: 1, method: 'ping' }, { 'MCP-Protocol-Version': '2025-06-18' })).status, 200)
  assert.equal((await mcp([{ jsonrpc: '2.0', id: 1, method: 'ping' }])).status, 400, 'バッチは受けない')
  assert.equal((await mcp('{ broken')).status, 400)
  assert.equal((await mcp(undefined, {}, 'GET')).status, 405, 'SSE は出さない')
  assert.equal((await mcp(undefined, {}, 'DELETE')).status, 405)
})

test('/mcp: 読むツールと案を置くツールはローカルと tailnet のユーザー。送る・待つは capability があるときだけ。タグ付きの端末は capability に書いたものだけ（無ければ 403）', async () => {
  assert.deepEqual(await toolNames(), LOOPBACK_TOOLS, 'ループバックは読むのと案を置くだけ（#565）')
  assert.deepEqual(await toolNames(USER), LOOPBACK_TOOLS)
  assert.deepEqual(await toolNames(SENDER), [...LOOPBACK_TOOLS, 'sai_send', 'sai_wait'].sort())
  assert.equal((await mcp({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, CI)).status, 403)
  assert.deepEqual(await toolNames(CI_READ), READ_TOOLS)

  const runs = runner.started.length
  const denied = await call('sai_send', { to: 'B1@r', text: '見て' }, USER)
  assert.equal(denied.isError, true)
  assert.ok(denied.text.includes(MCP_CAP), 'どの capability を与えればよいかを返す')
  assert.equal(runner.started.length, runs, '送っていない')
})

test('/mcp: Origin は capability に書いたものだけ（CORS もそれにだけ返す）。無ければ（CLI）通す', async () => {
  const ping = { jsonrpc: '2.0', id: 1, method: 'ping' }
  assert.equal((await mcp(ping, { ...USER, Origin: DASH })).status, 403, 'Origin を与えていない')
  let res = await mcp(ping, { ...SENDER, Origin: DASH })
  assert.equal(res.status, 200)
  assert.equal(res.headers.get('access-control-allow-origin'), DASH)
  assert.equal((await mcp(ping, { ...SENDER, Origin: 'https://evil.example.ts.net' })).status, 403)
  assert.equal((await mcp(ping, { Origin: `${base}` })).status, 403, 'ループバックでもブラウザからは通さない（DNS rebinding）')

  res = await fetch(`${base}/mcp`, { method: 'OPTIONS', headers: { ...SENDER, Origin: DASH, 'Access-Control-Request-Method': 'POST' } })
  assert.equal(res.status, 204)
  assert.equal(res.headers.get('access-control-allow-origin'), DASH)
  assert.match(res.headers.get('access-control-allow-methods') ?? '', /POST/)
  assert.match(res.headers.get('access-control-allow-headers') ?? '', /MCP-Protocol-Version/i)
  assert.equal((await fetch(`${base}/mcp`, { method: 'OPTIONS', headers: { ...USER, Origin: DASH } })).status, 403)
})

/** 使用量の偽物（createApp に渡す。この Mac の枠の使い方に左右されないように） */
const usage = { value: {} as Record<string, unknown>, async get() { return this.value } }

test('/mcp: sai_send は、相手のエージェントの使用量の枠が残り少なければ断る（#311 と同じ規則）', async () => {
  usage.value = { claude: { primary: { used_percent: 85, window_minutes: 300, resets_at: Date.now() / 1000 + 3600 }, at: '' } }
  try {
    const runs = runner.started.length
    const refused = await call('sai_send', { to: 'B1@r', text: '見て' }, SENDER)
    assert.equal(refused.isError, true)
    assert.match(refused.text, /5 時間の枠/)
    assert.equal(runner.started.length, runs, '送っていない（回数にも数えない）')
  } finally {
    usage.value = {}
  }
})

test('/mcp: 設定の既定の許可モード（#582）が素通しなら、何も選んでいないセッションにも tailnet から送れない', async () => {
  const putSettings = (reply_mode: string) => fetch(`${base}/api/settings`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ reply_mode }) })
  try {
    assert.equal((await putSettings('bypassPermissions')).status, 200)
    const list = await call('sai_sessions', {})
    assert.match(list.text, /B1@r.*送れない: 許可を聞かないモード（Bypass permissions）/)
    const runs = runner.started.length
    const refused = await call('sai_send', { to: 'B1@r', text: '見て' }, SENDER)
    assert.equal(refused.isError, true)
    assert.match(refused.text, /Bypass permissions/)
    assert.equal(runner.started.length, runs, '送っていない')
    // 既定が付くのは Claude だけ。Codex のセッションまで断らない（#722 のレビュー）
    assert.doesNotMatch(list.text.split('\n').find((l) => l.includes('K1@r')) ?? '', /許可を聞かないモード/)
    assert.ok(list.text.includes('K1@r'))
    // Accept edits のように聞かれるモードなら今までどおり
    assert.equal((await putSettings('acceptEdits')).status, 200)
    assert.doesNotMatch((await call('sai_sessions', {})).text.split('\n').find((l) => l.includes('B1@r')) ?? '', /許可を聞かないモード/)
  } finally {
    assert.equal((await putSettings('')).status, 200)
  }
})

test('/mcp: sai_sessions / sai_session / sai_progress', async () => {
  let r = await call('sai_sessions', {})
  assert.equal(r.isError, undefined)
  assert.ok(r.text.includes('A1@r'))
  assert.match(r.text, /R1@r.*送れない/, '別のマシンのセッションは送れない印付き')
  assert.match(r.text, /P1@r.*送れない: 許可を聞かないモード（Bypass permissions）/)
  // 待ちと最後の記録の時刻（#323。Manager が本文を読まずに急ぐものを選ぶ）
  assert.match(r.text, /C1@r.*（待ち: 許可待ち: Bash: ls） 最後の記録: \d{4}-\d{2}-\d{2}T/, '待ちは 1 行目だけ')
  assert.ok(!r.text.includes('2 行目'))
  assert.match(r.text, /A1@r.* 最後の記録: \S+ 最後の発言: 実装しました/)
  assert.doesNotMatch(r.text.split('\n').find((l) => l.includes('A1@r')) ?? '', /待ち:/, '待っていないセッションには付けない')
  r = await call('sai_sessions', { project: 'o/other' })
  assert.ok(r.text.includes('C1@r'))
  assert.ok(!r.text.includes('A1@r'))

  r = await call('sai_session', { id: 'A1@r' })
  assert.match(r.text, /人: 実装して/)
  assert.match(r.text, /エージェント: 実装しました/)
  assert.equal((await call('sai_session', { id: 'nope@r' })).isError, true)

  r = await call('sai_progress', { id: 'A1@r' })
  assert.equal(r.isError, undefined)
  assert.match(r.text, /手順はありません/)
})

test('/manager（#323 / #565）: .mcp.json の sai-read はループバックの /mcp を既定のポートで指し、スキルが名指しするのはループバックで見えるツール、許可に書くのは読むツールだけ', async () => {
  const root = join(import.meta.dirname, '..', '..')
  const config = JSON.parse(await readFile(join(root, '.mcp.json'), 'utf-8')) as { mcpServers: Record<string, { type?: string; url?: string }> }
  const entry = config.mcpServers['sai-read']
  assert.equal(entry?.type, 'http')
  assert.equal(entry?.url, `http://127.0.0.1:\${SAI_PORT:-${DEFAULT_PORT}}/mcp`)
  assert.equal(config.mcpServers.sai, undefined, 'SAI が --mcp-config で渡す sai（同じ project だけ・送れる）と名前を重ねない')

  // ループバックからヘッダ無しで見えるのは読むツールと案を置くツールだけ（Manager の会話から送れない）
  assert.deepEqual(await toolNames(), LOOPBACK_TOOLS)
  const skill = await readFile(join(root, '.claude', 'skills', 'manager', 'SKILL.md'), 'utf-8')
  const named = [...new Set([...skill.matchAll(/mcp__sai-read__(\w+)/g)].map((m) => m[1]!))].sort()
  assert.deepEqual(named, LOOPBACK_TOOLS, 'スキルが名指しするツールは、ループバックの /mcp にある（名前を変えたらスキルも直す）')

  const settings = JSON.parse(await readFile(join(root, '.claude', 'settings.json'), 'utf-8')) as { permissions?: { allow?: string[] } }
  const allowed = (settings.permissions?.allow ?? []).filter((rule) => rule.startsWith('mcp__sai')).sort()
  assert.deepEqual(allowed, READ_TOOLS.map((t) => `mcp__sai-read__${t}`).sort(), '許可を聞かずに通すのは sai-read の読むツールだけ（sai_suggest も、mcp__sai__ の送る・待つ・承認も入れない。#565）')
})

test('/mcp: sai_send は見出し付きで相手のターンを起動し、sai_wait で返答を受け取る。素通し・別のマシン・長すぎる本文・回数の上限は断る', async () => {
  const sent = await call('sai_send', { to: 'B1@r', text: 'レビューして' }, SENDER)
  assert.equal(sent.isError, undefined, sent.text)
  const messageId = /message_id: ([0-9a-f]+)/.exec(sent.text)?.[1] ?? ''
  assert.ok(messageId)
  const launched = runner.started[runner.started.length - 1]!
  assert.equal(launched.id, 'B1@r')
  assert.ok(launched.cmd.text.startsWith(deliveredFromTailnet('me@example.com', messageId, 'レビューして').split('\n')[0]!), '人の入力と見分けられる見出し')

  assert.match((await call('sai_send', { to: 'P1@r', text: 'やって' }, SENDER)).text, /Bypass permissions/)
  // Auto mode（#691）を選んだセッションにも tailnet からは送れない（素通しと同じ扱い）
  const setMode = (mode: string) => fetch(`${base}/api/sessions/P1%40r/meta`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ permission_mode: mode }) })
  assert.equal((await setMode('auto')).status, 200)
  assert.match((await call('sai_send', { to: 'P1@r', text: 'やって' }, SENDER)).text, /Auto mode.*tailnet から送れません/)
  assert.equal((await setMode('bypassPermissions')).status, 200)
  assert.equal((await call('sai_send', { to: 'R1@r', text: 'やって' }, SENDER)).isError, true)
  assert.equal((await call('sai_send', { to: 'A1@r', text: 'あ'.repeat(AGENT_TEXT_MAX_CHARS + 1) }, SENDER)).isError, true)

  assert.equal((await call('sai_wait', { message_id: 'ffff' }, SENDER)).isError, true, '知らない id')
  const pending = await call('sai_wait', { message_id: messageId, wait_seconds: 0 }, SENDER)
  assert.equal(pending.isError, undefined)
  assert.match(pending.text, /まだ返答がありません/)
  // 相手のターンが終わった（見出しの id で探す）
  await appendFile(feedFile, JSON.stringify(row(new Date(), 'B1', { repo: 'r', cwd: work, project: 'o/r', user_text: deliveredFromTailnet('me@example.com', messageId, 'レビューして'), text: 'レビュー済みです' })) + '\n')
  const done = await call('sai_wait', { message_id: messageId, wait_seconds: 0 }, SENDER)
  assert.equal(done.text, 'レビュー済みです')

  for (let i = 1; i < MCP_SEND_MAX; i++) assert.equal((await call('sai_send', { to: 'A1@r', text: `${i}` }, SENDER)).isError, undefined)
  assert.match((await call('sai_send', { to: 'A1@r', text: 'もう一回' }, SENDER)).text, /回まで/)
})

type ListedSession = { id: string; manager_draft?: { text: string; at: number } }
const listed = async () => (await (await fetch(`${base}/api/sessions?days=1`)).json()) as { rev: string; sessions: ListedSession[] }
const draftOf = async (id: string) => (await listed()).sessions.find((s) => s.id === id)?.manager_draft
const suggestionAction = (id: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(`${base}/api/sessions/${encodeURIComponent(id)}/suggestion`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) })

test('/mcp: sai_suggest は入力欄に案を置くだけでターンを起こさない。一覧・詳細に載り rev が変わる。別のリポジトリ・素通しにも置け、置き直すと上書き（#565）', async () => {
  const started = runner.started.length
  const prev = await listed()
  assert.equal(prev.sessions.find((s) => s.id === 'B1@r')?.manager_draft, undefined)

  const placed = await call('sai_suggest', { to: 'B1@r', text: '  CI を見て\n落ちていたら直して  ' })
  assert.equal(placed.isError, undefined, placed.text)
  assert.match(placed.text, /送ってはいません/)
  const next = await listed()
  assert.notEqual(next.rev, prev.rev, '置いただけで画面のポーリングが拾う')
  assert.equal(next.sessions.find((s) => s.id === 'B1@r')?.manager_draft?.text, 'CI を見て\n落ちていたら直して')
  const detail = (await (await fetch(`${base}/api/sessions/B1%40r?days=1`)).json()) as { session: ListedSession }
  assert.equal(detail.session.manager_draft?.text, 'CI を見て\n落ちていたら直して', '詳細にも載る')
  assert.equal(runner.started.length, started, 'ターンは起こさない')
  assert.equal(runner.running('B1@r'), false)

  assert.equal((await call('sai_suggest', { to: 'B1@r', text: '置き直し' })).isError, undefined)
  assert.equal((await draftOf('B1@r'))?.text, '置き直し', '1 セッションに 1 つで、置き直すと上書き')

  assert.equal((await call('sai_suggest', { to: 'C1@r', text: '別のリポジトリ' })).isError, undefined, '別のリポジトリにも置ける')
  assert.equal((await call('sai_suggest', { to: 'P1@r', text: '素通し' })).isError, undefined, '素通しにも置ける（送るのは人）')
  assert.match((await call('sai_suggest', { to: 'R1@r', text: '別のマシン' })).text, /置けません/, '入力欄が出ない（返信できない）ものには置かない')
  assert.equal((await call('sai_suggest', { to: 'nope@r', text: 'x' })).isError, true)
  assert.equal((await call('sai_suggest', { to: 'A1@r', text: 'あ'.repeat(AGENT_TEXT_MAX_CHARS + 1) })).isError, true)
  assert.equal((await call('sai_suggest', { to: 'A1@r', text: '   ' })).isError, true)
  assert.equal(runner.started.length, started)

  const log = await readFile(join(dir, 'reply.log'), 'utf-8')
  assert.match(log, /mcp:このマシン → B1@r 案を置いた/)

  // タグ付きの端末は capability に draft が無ければ呼べない
  assert.equal((await call('sai_suggest', { to: 'B1@r', text: 'x' }, CI_READ)).isError, true)
})

test('/mcp: Manager の案は人の入力が後に来たら消え、24 時間で消える。捨てる・入れるは同一オリジンのみで reply.log に残る（#565）', async () => {
  assert.equal((await call('sai_suggest', { to: 'A1@r', text: 'テストを足して' })).isError, undefined)
  assert.equal((await draftOf('A1@r'))?.text, 'テストを足して')
  await new Promise((r) => setTimeout(r, 1100)) // 行の ts は秒まで
  await appendFile(feedFile, JSON.stringify(row(new Date(), 'A1', { repo: 'r', cwd: work, project: 'o/r', event: 'UserPromptSubmit', user_text: '自分で打った', text: '' })) + '\n')
  assert.equal(await draftOf('A1@r'), undefined, '人が何か送ったら、その前の文脈の案は出さない')

  // 処理中に置いた案は、回っていたターンが終わっただけでは消さない（#586 のレビュー。Codex は入力の行を書かず、入力はターン完了の行で届く）
  runner.busy.set('C1@r', {} as unknown as Replying)
  assert.equal((await call('sai_suggest', { to: 'C1@r', text: '終わったら見て' })).isError, undefined)
  runner.busy.delete('C1@r')
  await new Promise((r) => setTimeout(r, 1100))
  await appendFile(feedFile, JSON.stringify(row(new Date(), 'C1', { repo: 'r', cwd: work, project: 'o/other', agent: 'codex', user_text: '回っていたターンの入力', text: '終わりました' })) + '\n')
  assert.equal((await draftOf('C1@r'))?.text, '終わったら見て', '回っていたターンの終わりでは消さない')
  await appendFile(feedFile, JSON.stringify(row(new Date(), 'C1', { repo: 'r', cwd: work, project: 'o/other', agent: 'codex', user_text: '次の指示', text: 'やりました' })) + '\n')
  assert.equal(await draftOf('C1@r'), undefined, 'その次のターンが来たら、人が送ったので消す')

  // 24 時間を過ぎた案はファイルにあっても出さない
  const file = join(dir, 'suggestions.json')
  const saved = JSON.parse(await readFile(file, 'utf-8')) as Record<string, { text: string; from: string; at: number }>
  saved['B1@r'] = { text: '古い案', from: 'このマシン', at: Date.now() - 25 * 60 * 60 * 1000 }
  await writeFile(file, JSON.stringify(saved))
  assert.equal(await draftOf('B1@r'), undefined)

  assert.equal((await call('sai_suggest', { to: 'B1@r', text: '捨てる案' })).isError, undefined)
  const draft = (await draftOf('B1@r'))!
  assert.equal((await suggestionAction('B1@r', { action: 'discard', at: draft.at }, { Origin: 'https://evil.example' })).status, 403, '別サイトからは捨てさせない')
  assert.equal((await suggestionAction('B1@r', { action: 'drop', at: draft.at })).status, 400)
  const stale = (await (await suggestionAction('B1@r', { action: 'discard', at: draft.at - 1 })).json()) as { taken: boolean }
  assert.equal(stale.taken, false, '画面が見ていた案と違えば（置き直されていたら）消さない')
  assert.equal((await draftOf('B1@r'))?.text, '捨てる案')
  const discarded = (await (await suggestionAction('B1@r', { action: 'discard', at: draft.at })).json()) as { taken: boolean }
  assert.equal(discarded.taken, true)
  assert.equal(await draftOf('B1@r'), undefined)

  assert.equal((await call('sai_suggest', { to: 'B1@r', text: '入れる案' })).isError, undefined)
  const accepted = (await (await suggestionAction('B1@r', { action: 'accept', at: (await draftOf('B1@r'))!.at })).json()) as { taken: boolean }
  assert.equal(accepted.taken, true)
  assert.equal(await draftOf('B1@r'), undefined, '入れたら案としては消える（入力欄の打ちかけになる）')
  const log = await readFile(join(dir, 'reply.log'), 'utf-8')
  assert.match(log, /B1@r Manager の案（mcp:このマシン）を捨てた/)
  assert.match(log, /B1@r Manager の案（mcp:このマシン）を入力欄に入れた/)
})

test('/mcp: sai_suggest / sai_send の宛先は呼び名でも書ける。同じ名前が複数なら置かず・送らずに候補を返す（#625）', async () => {
  const named = await fetch(`${base}/api/sessions/B1%40r/meta`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'SessionA' }) })
  assert.equal(named.status, 200)
  const started = runner.started.length
  const placed = await call('sai_suggest', { to: ' sessiona ', text: '名前で置く' })
  assert.equal(placed.isError, undefined, placed.text)
  assert.match(placed.text, /^B1@r「SessionA」の入力欄に案を置きました/)
  assert.equal((await draftOf('B1@r'))?.text, '名前で置く')
  // worktree 名 `r` は何本も居るので当てない
  const dup = await call('sai_suggest', { to: 'r', text: 'どれ' })
  assert.equal(dup.isError, true)
  assert.match(dup.text, /「r」に当たる相手が \d+ つあります.*送っていません/)
  assert.ok(dup.text.includes('- B1@r「SessionA」'))
  assert.ok(!dup.text.includes('R1@r'), '別のマシン（案を置けない相手）は名前では当たらない')
  assert.equal((await call('sai_suggest', { to: 'Sess', text: 'x' })).isError, true, '前方一致はしない')
  // 送る方も同じ引き当て（ここでは回数の上限に当たって送られないが、宛先は先に引かれる）
  const ambiguous = await call('sai_send', { to: 'r', text: '見て' }, SENDER)
  assert.match(ambiguous.text, /当たる相手が \d+ つあります/)
  assert.ok(!ambiguous.text.includes('P1@r'), '素通しのセッションは、送る宛先としては名前で当たらない')
  assert.equal(runner.started.length, started, 'どれもターンを起こしていない')
  // 素通しのセッションが同じ名前を持っていたら、送れる方が 1 つでも名前では送らない（#662 のレビュー）
  const twin = await fetch(`${base}/api/sessions/P1%40r/meta`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'sessiona' }) })
  assert.equal(twin.status, 200)
  const hidden = await call('sai_send', { to: 'SessionA', text: '見て' }, SENDER)
  assert.equal(hidden.isError, true)
  assert.match(hidden.text, /当たる相手が 2 つあります（うち 1 つは送れないセッション/)
  assert.equal(runner.started.length, started)
})
