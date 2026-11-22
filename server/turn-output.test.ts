// GET /api/sessions/<id>/turn-output（#846）。本物の createApp と本物の ProgressReader に、作った transcript / rollout を読ませる。
// 手順の一覧には中身を載せないこと、出す相手が返答のファイルと同じこと、ほかのターンの戻りは読めないことを見る。
// 本物の ~/.claude / ~/.codex / ~/.agent-feed は触らない
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, request } from 'node:http'
import type { Server } from 'node:http'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createApp } from './app.ts'
import { Authenticator, WhoisUnavailable } from './auth.ts'
import type { WhoisInfo } from './auth.ts'
import { MCP_CAP } from './mcp/access.ts'
import { FeedStore } from './rows/store.ts'
import { localDate } from './rows/aggregate.ts'
import { row } from './rows/aggregate.test.ts'
import { ProgressReader } from './local/progress.ts'
import { Approvals } from './approvals/approvals.ts'
import { UsageStore } from './local/usage.ts'
import { claudeProjectName } from '../shared/progress.ts'
import type { SessionProgressResponse, TurnOutputResponse } from '../shared/types.ts'
import type { CodexApp } from './reply/codexAppServer.ts'
import type { LiveCommandOutput } from './reply/codexLiveOutput.ts'

let dir: string
let server: Server
let base: string
const SECRET = 'SECRET-作り物の出力'
const OTHER = 'OTHER-別のターンの出力'
const SERVE_HOST = 'mac.tail1234.ts.net'
const TAILNET = { 'Tailscale-User-Login': 'me@example.com', 'Tailscale-User-Name': 'Me', 'X-Forwarded-For': '100.64.0.1', 'X-Forwarded-Proto': 'https', Host: SERVE_HOST }
const TAGGED_ADDR = '100.64.0.7'
const DOWN_ADDR = '100.64.0.8'
const now = new Date()
/** 偽の app-server が「いま走っている」と返すコマンドの途中の出力（#846）。テストごとに入れ替える */
const LIVE = 'LIVE-作り物の途中の出力'
let liveFor: Record<string, LiveCommandOutput[]> = {}
const liveAsked: string[] = []
const fakeCodex: CodexApp = {
  running: () => false,
  replying: () => ({}),
  snapshot: () => ({}),
  getApproval: () => undefined,
  start: async () => {},
  answer: () => ({ ok: false, status: 404, error: 'none' }) as ReturnType<CodexApp['answer']>,
  liveOutput: (id) => {
    liveAsked.push(id)
    return liveFor[id] ?? []
  },
}
const ago = (minutes: number) => new Date(now.getTime() - minutes * 60_000)
const tsOf = (at: Date) => row(at, 'x').ts
const j = (v: unknown) => JSON.stringify(v)
const user = (at: Date, content: unknown, extra: object = {}) => j({ type: 'user', timestamp: at.toISOString(), message: { role: 'user', content }, ...extra })
const use = (at: Date, id: string, name: string, input: object) => j({ type: 'assistant', timestamp: at.toISOString(), message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }], stop_reason: 'tool_use' } })
const out = (at: Date, id: string, toolUseResult: unknown) => user(at, [{ type: 'tool_result', tool_use_id: id, content: 'モデルに渡した文' }], { toolUseResult })
const said = (at: Date, text: string) => j({ type: 'assistant', timestamp: at.toISOString(), message: { role: 'assistant', content: [{ type: 'text', text }], stop_reason: 'end_turn' } })

const url = (id: string, ts: string, ref: string) => `/api/sessions/${encodeURIComponent(id)}/turn-output?ts=${encodeURIComponent(ts)}&ref=${encodeURIComponent(ref)}&days=2`
const send = (path: string, headers: Record<string, string> = {}, method = 'GET', body?: string) =>
  new Promise<{ status: number; headers: Record<string, unknown>; body: string }>((resolve, reject) => {
    const at = new URL(base)
    const req = request({ host: at.hostname, port: at.port, path, method, headers }, (res) => {
      let text = ''
      res.on('data', (c) => (text += c))
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: text }))
    })
    req.on('error', reject)
    req.end(body)
  })
const output = async (id: string, ts: string, ref: string) => {
  const res = await send(url(id, ts, ref))
  return { status: res.status, body: JSON.parse(res.body) as TurnOutputResponse, raw: res }
}

before(async () => {
  process.env.AGENT_FEED_HOST = 'testmac'
  dir = await mkdtemp(join(tmpdir(), 'sai-turn-output-'))
  const feedDir = join(dir, 'feed')
  const projectDir = join(dir, 'projects', claudeProjectName(dir))
  const rolloutDir = join(dir, 'codex', String(now.getFullYear()), String(now.getMonth() + 1).padStart(2, '0'), String(now.getDate()).padStart(2, '0'))
  await mkdir(feedDir)
  await mkdir(projectDir, { recursive: true })
  await mkdir(rolloutDir, { recursive: true })
  await writeFile(join(projectDir, 'C1.jsonl'), [
    user(ago(40), '前のターン'), use(ago(39), 'toolu_old', 'Bash', { command: 'ls' }), out(ago(39), 'toolu_old', { stdout: OTHER, stderr: '' }), said(ago(38), '見ました'),
    user(ago(30), '直して'),
    use(ago(29), 'toolu_bash', 'Bash', { command: 'pnpm test' }), out(ago(29), 'toolu_bash', { stdout: SECRET, stderr: '' }),
    use(ago(28), 'toolu_edit', 'Edit', { file_path: '/w/a.ts' }), out(ago(28), 'toolu_edit', { filePath: '/w/a.ts', originalFile: 'ORIGINAL-ファイル全体', structuredPatch: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-古い', '+新しい'] }] }),
    use(ago(27), 'toolu_read', 'Read', { file_path: '/w/a.ts' }), out(ago(27), 'toolu_read', { file: { content: 'READ-読んだ中身' } }),
    said(ago(26), '直しました'),
  ].join('\n') + '\n')
  await writeFile(join(projectDir, 'R1.jsonl'), [user(ago(30), 'x'), use(ago(29), 'toolu_far', 'Bash', { command: 'ls' }), out(ago(29), 'toolu_far', { stdout: SECRET }), said(ago(26), 'y')].join('\n') + '\n')
  const ev = (at: Date, payload: object) => j({ timestamp: at.toISOString(), type: 'event_msg', payload })
  await writeFile(join(rolloutDir, 'rollout-2026-10-02T00-00-00-X1.jsonl'), [
    ev(ago(30), { type: 'task_started' }),
    j({ timestamp: ago(29).toISOString(), type: 'response_item', payload: { type: 'custom_tool_call', name: 'exec', call_id: 'call_1', input: 'const r = await tools.exec_command({"cmd":"cargo test"})' } }),
    ev(ago(29), { type: 'item_completed', item: { type: 'CommandExecution', id: 'x', command: ['/bin/sh', '-lc', 'cargo test'], aggregated_output: SECRET, exit_code: 0 } }),
    j({ timestamp: ago(28).toISOString(), type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: 'call_1', output: [{ type: 'input_text', text: 'モデルに渡した文' }] } }),
    ev(ago(26), { type: 'task_complete' }),
  ].join('\n') + '\n')
  const c = { repo: 'r', cwd: dir, agent: 'claude' } as const
  const lines = [
    row(ago(38), 'C1', { ...c, user_text: '前のターン', text: '見ました' }),
    row(ago(30), 'C1', { ...c, event: 'UserPromptSubmit', user_text: '直して', text: '' }),
    row(ago(26), 'C1', { ...c, user_text: '直して', text: '直しました' }),
    row(ago(26), 'R1', { ...c, host: 'far-away-machine', text: 'y' }),
    row(ago(26), 'X1', { repo: 'r', cwd: dir, agent: 'codex', session_source: 'rollout', text: '終わりました' }),
    row(ago(26), 'O1', { repo: 'r', cwd: dir, agent: 'opencode', text: '終わり' }),
    row(ago(26), 'XR', { repo: 'r', cwd: dir, agent: 'codex', host: 'far-away-machine', text: '別のマシン' }),
  ]
  await writeFile(join(feedDir, `${localDate(now.toISOString())}.jsonl`), lines.map((l) => j(l)).join('\n') + '\n')
  const auth = new Authenticator(async (addr): Promise<WhoisInfo | null> => {
    if (addr === DOWN_ADDR) throw new WhoisUnavailable('timeout')
    if (addr === TAGGED_ADDR) return { login: 'tagged-devices', tagged: true, node: 'bot', caps: { [MCP_CAP]: [{ tools: ['read'] }] } }
    return addr === '100.64.0.1' ? { login: 'me@example.com', tagged: false, node: 'laptop', caps: {} } : null
  }, 30_000)
  const app = createApp(
    new FeedStore(feedDir), join(dir, 'dist'), undefined, new Approvals(), undefined, undefined, auth,
    { tmux: { run: async () => '' }, ps: async () => '', codexApp: fakeCodex }, undefined, undefined, undefined,
    new UsageStore(join(dir, 'codex'), join(dir, 'projects'), feedDir),
    new ProgressReader(join(dir, 'projects'), join(dir, 'codex')),
  )
  server = createServer((req, res) => void app(req, res))
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const addr = server.address()
  base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`
})

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
  await rm(dir, { recursive: true, force: true })
})

test('手順の一覧には参照だけを載せ、出力は載せない。開けるのはコマンドと編集だけ', async () => {
  const res = await send(`/api/sessions/C1%40r/turn-steps?ts=${encodeURIComponent(tsOf(ago(26)))}&days=2`)
  const body = JSON.parse(res.body) as { steps: { tool: string; output_ref?: string; output_kind?: string }[] }
  assert.deepEqual(body.steps.map((s) => [s.tool, s.output_ref, s.output_kind]), [['Bash', 'toolu_bash', 'output'], ['Edit', 'toolu_edit', 'diff'], ['Read', undefined, undefined]])
  assert.equal(res.body.includes(SECRET), false)
})

test('Claude: 押した手順の出力と差分を返す。ファイル全体は返さず、応答はキャッシュさせない', async () => {
  const got = await output('C1@r', tsOf(ago(26)), 'toolu_bash')
  assert.deepEqual([got.status, got.body.found, got.body.sections], [200, true, [{ label: 'stdout', kind: 'output', text: SECRET }]])
  assert.equal(got.raw.headers['cache-control'], 'no-store')
  const edit = await output('C1@r', tsOf(ago(26)), 'toolu_edit')
  assert.deepEqual(edit.body.sections, [{ label: '/w/a.ts', kind: 'diff', text: '@@ -1,1 +1,1 @@\n-古い\n+新しい' }])
  assert.equal(edit.raw.body.includes('ORIGINAL'), false)
})

test('Codex: rollout の項目の出力を返す', async () => {
  const got = await output('X1@r', tsOf(ago(26)), 'call_1')
  assert.deepEqual([got.body.found, got.body.sections], [true, [{ label: 'cargo test', kind: 'output', text: SECRET }]])
})

test('そのターンの手順に無い参照は読まない（別のターン・開けないツール・無い参照）。別のマシン・OpenCode も found: false', async () => {
  for (const [id, ts, ref] of [
    ['C1@r', tsOf(ago(26)), 'toolu_old'],
    ['C1@r', tsOf(ago(26)), 'toolu_read'],
    ['C1@r', tsOf(ago(26)), 'toolu_none'],
    ['C1@r', tsOf(ago(38)), 'toolu_bash'],
    ['R1@r', tsOf(ago(26)), 'toolu_far'],
    ['O1@r', tsOf(ago(26)), 'toolu_bash'],
  ] as const) {
    const got = await output(id, ts, ref)
    assert.deepEqual([got.status, got.body.found, got.body.sections], [200, false, []], ref)
    assert.equal(got.raw.body.includes('SECRET') || got.raw.body.includes('OTHER') || got.raw.body.includes('READ'), false, ref)
  }
  assert.equal((await output('C1@r', tsOf(ago(38)), 'toolu_old')).body.sections[0]?.text, OTHER, '自分のターンなら読める')
})

test('ts・ref の形が違えば 400、窓に無いセッションは 404、書き込みのメソッドは受けない', async () => {
  assert.equal((await send(url('C1@r', '', 'toolu_bash'))).status, 400)
  for (const ref of ['', '../../etc/passwd', 'a b']) assert.equal((await send(url('C1@r', tsOf(ago(26)), ref))).status, 400, ref)
  assert.equal((await send(url('nope@r', tsOf(ago(26)), 'toolu_bash'))).status, 404)
  assert.equal((await send(url('C1@r', tsOf(ago(26)), 'toolu_bash'), {}, 'POST')).status, 405)
})

test('出す相手は返答のファイルと同じ: 本人の tailnet には出す。タグ付き・whois が聞けない・合わない・Host が違う要求には出さない', async () => {
  const path = url('C1@r', tsOf(ago(26)), 'toolu_bash')
  const missing = url('nope@r', tsOf(ago(26)), 'toolu_bash')
  const far = await send(path, TAILNET)
  assert.equal(far.status, 200)
  assert.equal(far.body.includes(SECRET), true)
  for (const [name, headers, status] of [
    ['タグ付き（capability があっても）', { 'X-Forwarded-For': TAGGED_ADDR, 'X-Forwarded-Proto': 'https', Host: SERVE_HOST }, 401],
    ['whois が聞けなかった', { ...TAILNET, 'X-Forwarded-For': DOWN_ADDR }, 401],
    ['whois が「居ない」', { ...TAILNET, 'X-Forwarded-For': '100.64.0.99' }, 401],
    ['whois と別のログイン', { ...TAILNET, 'Tailscale-User-Login': 'other@example.com' }, 401],
    ['Serve の名前でない Host', { ...TAILNET, Host: 'evil.example.com' }, 403],
    ['ループバックに向け直した外の名前', { Host: 'evil.example.com' }, 403],
  ] as const) {
    const res = await send(path, headers)
    assert.equal(res.status, status, name)
    assert.equal(res.body.includes('SECRET'), false, name)
    const other = await send(missing, headers)
    assert.deepEqual([other.status, other.body], [res.status, res.body], `${name}: セッションの有無を漏らさない`)
  }
})

test('/mcp に出力を読む道具は無い。sai_progress の手順にも出力は載らない', async () => {
  const headers = { 'X-Forwarded-For': TAGGED_ADDR, 'X-Forwarded-Proto': 'https', Host: SERVE_HOST, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' }
  const call = async (id: number, method: string, params: object = {}) => send('/mcp', headers, 'POST', j({ jsonrpc: '2.0', id, method, params }))
  const list = await call(1, 'tools/list')
  assert.equal(list.status, 200, list.body)
  const names = (JSON.parse(list.body) as { result: { tools: { name: string }[] } }).result.tools.map((t) => t.name)
  assert.ok(names.includes('sai_progress'))
  assert.deepEqual(names.filter((n) => /output|step|transcript/i.test(n)), [])
  const progress = await call(2, 'tools/call', { name: 'sai_progress', arguments: { id: 'C1@r' } })
  assert.equal(progress.status, 200, progress.body)
  assert.equal(progress.body.includes('SECRET'), false)
  assert.equal(progress.body.includes('pnpm test'), true, '手順そのものは読めている（空振りのテストにしない）')
  assert.equal((await send(`/mcp/sessions/C1%40r/turn-output?ts=x&ref=toolu_bash`, headers)).status, 401)
})

// ---- 走っている Codex のコマンドの途中の出力（#846 の 2 つ目）。偽の app-server が返すものを、`?live=1` でだけ出す
const liveUrl = (id: string) => `/api/sessions/${encodeURIComponent(id)}/turn-output?live=1&days=2`
const running = (text: string, dropped = 0): LiveCommandOutput => ({ itemId: 'item-1', command: 'cargo test', started: ago(1).toISOString(), text, dropped })

test('live: 走っているコマンドの途中の出力を、コマンドごとの節で末尾だけ返す。応答はキャッシュさせない', async () => {
  liveFor = { 'X1@r': [running(`\u001b[32m${LIVE}\u001b[0m\n`, 10)] }
  const res = await send(liveUrl('X1@r'))
  const body = JSON.parse(res.body) as TurnOutputResponse
  assert.deepEqual([res.status, body.found, body.live, body.ts, body.ref], [200, true, true, '', ''])
  assert.deepEqual(body.sections, [{ label: 'cargo test', kind: 'output', text: '', tail: `${LIVE}\n`, omitted: 10 }])
  assert.equal(res.headers['cache-control'], 'no-store')
  liveFor = {}
})

test('live: 走っていない・Codex でない・別のマシンは found: false。Codex でないセッションのためには app-server に聞かない', async () => {
  liveFor = { 'C1@r': [running(LIVE)], 'XR@r': [running(LIVE)], 'O1@r': [running(LIVE)] }
  liveAsked.length = 0
  for (const id of ['X1@r', 'C1@r', 'XR@r', 'O1@r']) {
    const res = await send(liveUrl(id))
    const body = JSON.parse(res.body) as TurnOutputResponse
    assert.deepEqual([res.status, body.found, body.sections, body.live], [200, false, [], true], id)
    assert.equal(res.body.includes('LIVE'), false, id)
  }
  assert.deepEqual(liveAsked, ['X1@r'])
  assert.equal((await send(liveUrl('nope@r'))).status, 404)
  assert.equal((await send(liveUrl('X1@r'), {}, 'POST')).status, 405)
  liveFor = {}
})

test('live: 処理中の手順には「開ける」印だけを載せ、中身は載せない。sai_progress にも載らない', async () => {
  const progress = async () => {
    const res = await send('/api/sessions/X1%40r/progress?days=2')
    return { raw: res.body, body: JSON.parse(res.body) as SessionProgressResponse }
  }
  const idle = await progress()
  assert.equal(idle.body.live_output, undefined, '走っていなければ印は無い')
  liveFor = { 'X1@r': [running(LIVE)] }
  const live = await progress()
  assert.equal(live.body.live_output, true)
  assert.notEqual(live.body.rev, idle.body.rev, '印だけ変わっても描き直す')
  assert.equal(live.raw.includes('LIVE'), false)
  const headers = { 'X-Forwarded-For': TAGGED_ADDR, 'X-Forwarded-Proto': 'https', Host: SERVE_HOST, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' }
  const mcp = await send('/mcp', headers, 'POST', j({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'sai_progress', arguments: { id: 'X1@r' } } }))
  assert.equal(mcp.status, 200, mcp.body)
  assert.equal(mcp.body.includes('LIVE'), false)
  liveFor = {}
})

test('live: 出す相手は返答のファイルと同じ。本人の tailnet には出し、タグ付き・whois が聞けない・Host が違う要求には出さない', async () => {
  liveFor = { 'X1@r': [running(LIVE)] }
  const far = await send(liveUrl('X1@r'), TAILNET)
  assert.equal(far.status, 200)
  assert.equal(far.body.includes(LIVE), true)
  for (const [name, headers, status] of [
    ['タグ付き（capability があっても）', { 'X-Forwarded-For': TAGGED_ADDR, 'X-Forwarded-Proto': 'https', Host: SERVE_HOST }, 401],
    ['whois が聞けなかった', { ...TAILNET, 'X-Forwarded-For': DOWN_ADDR }, 401],
    ['Serve の名前でない Host', { ...TAILNET, Host: 'evil.example.com' }, 403],
  ] as const) {
    const res = await send(liveUrl('X1@r'), headers)
    assert.equal(res.status, status, name)
    assert.equal(res.body.includes('LIVE'), false, name)
    const other = await send(liveUrl('nope@r'), headers)
    assert.deepEqual([other.status, other.body], [res.status, res.body], `${name}: セッションの有無を漏らさない`)
  }
  assert.equal((await send('/mcp/sessions/X1%40r/turn-output?live=1', { 'X-Forwarded-For': TAGGED_ADDR, 'X-Forwarded-Proto': 'https', Host: SERVE_HOST })).status, 401)
  liveFor = {}
})
