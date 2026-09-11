// tailnet から MCP で呼ぶ口（`/mcp`。#312 の A）を、本物の createApp に叩かせる。
// 身元は whois を差し替えて作る（ユーザーの端末 / capability を与えたユーザー / タグ付きの端末）
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import type { Server } from 'node:http'
import { appendFile, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AGENT_TEXT_MAX_CHARS, deliveredFromTailnet } from '../../shared/agentMessages.ts'
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
      row(minutesAgo(7), 'C1', { repo: 'r', cwd: work, project: 'o/other' }),
      row(minutesAgo(6), 'P1', { repo: 'r', cwd: work, project: 'o/r' }),
      row(minutesAgo(5), 'R1', { repo: 'r', cwd: work, project: 'o/r', host: 'mini' }),
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

test('/mcp: 読むツールはローカルと tailnet のユーザー。送る・待つは capability があるときだけ。タグ付きの端末は capability に書いたものだけ（無ければ 403）', async () => {
  assert.deepEqual(await toolNames(), READ_TOOLS, 'ループバックは読むだけ')
  assert.deepEqual(await toolNames(USER), READ_TOOLS)
  assert.deepEqual(await toolNames(SENDER), [...READ_TOOLS, 'sai_send', 'sai_wait'].sort())
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

test('/mcp: sai_sessions / sai_session / sai_progress', async () => {
  let r = await call('sai_sessions', {})
  assert.equal(r.isError, undefined)
  assert.ok(r.text.includes('A1@r'))
  assert.match(r.text, /R1@r.*送れない/, '別のマシンのセッションは送れない印付き')
  assert.match(r.text, /P1@r.*送れない: 素通し/)
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

test('/mcp: sai_send は見出し付きで相手のターンを起動し、sai_wait で返答を受け取る。素通し・別のマシン・長すぎる本文・回数の上限は断る', async () => {
  const sent = await call('sai_send', { to: 'B1@r', text: 'レビューして' }, SENDER)
  assert.equal(sent.isError, undefined, sent.text)
  const messageId = /message_id: ([0-9a-f]+)/.exec(sent.text)?.[1] ?? ''
  assert.ok(messageId)
  const launched = runner.started[runner.started.length - 1]!
  assert.equal(launched.id, 'B1@r')
  assert.ok(launched.cmd.text.startsWith(deliveredFromTailnet('me@example.com', messageId, 'レビューして').split('\n')[0]!), '人の入力と見分けられる見出し')

  assert.match((await call('sai_send', { to: 'P1@r', text: 'やって' }, SENDER)).text, /素通し/)
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
