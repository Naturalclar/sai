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
import type { TurnOutputResponse } from '../shared/types.ts'

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
  ]
  await writeFile(join(feedDir, `${localDate(now.toISOString())}.jsonl`), lines.map((l) => j(l)).join('\n') + '\n')
  const auth = new Authenticator(async (addr): Promise<WhoisInfo | null> => {
    if (addr === DOWN_ADDR) throw new WhoisUnavailable('timeout')
    if (addr === TAGGED_ADDR) return { login: 'tagged-devices', tagged: true, node: 'bot', caps: { [MCP_CAP]: [{ tools: ['read'] }] } }
    return addr === '100.64.0.1' ? { login: 'me@example.com', tagged: false, node: 'laptop', caps: {} } : null
  }, 30_000)
  const app = createApp(
    new FeedStore(feedDir), join(dir, 'dist'), undefined, new Approvals(), undefined, undefined, auth,
    { tmux: { run: async () => '' }, ps: async () => '' }, undefined, undefined, undefined,
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
