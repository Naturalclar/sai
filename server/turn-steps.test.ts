// GET /api/sessions/<id>/turn-steps（#605）。本物の createApp と本物の ProgressReader に、作った transcript / rollout を読ませる。
// 本物の ~/.claude / ~/.codex / ~/.agent-feed は触らない
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import type { Server } from 'node:http'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createApp } from './app.ts'
import { FeedStore } from './rows/store.ts'
import { localDate } from './rows/aggregate.ts'
import { row } from './rows/aggregate.test.ts'
import { ProgressReader } from './local/progress.ts'
import { Approvals } from './approvals/approvals.ts'
import { UsageStore } from './local/usage.ts'
import { claudeProjectName } from '../shared/progress.ts'
import type { TurnStepsResponse } from '../shared/types.ts'

let dir: string
let server: Server
let base: string
const now = new Date()
const ago = (minutes: number) => new Date(now.getTime() - minutes * 60_000)
const user = (at: Date, content: unknown) => JSON.stringify({ type: 'user', timestamp: at.toISOString(), message: { role: 'user', content } })
const use = (at: Date, name: string, input: Record<string, unknown>) => JSON.stringify({ type: 'assistant', timestamp: at.toISOString(), message: { role: 'assistant', content: [{ type: 'tool_use', id: 't', name, input }], stop_reason: 'tool_use' } })
const out = (at: Date) => user(at, [{ type: 'tool_result', tool_use_id: 't', content: 'SECRET の出力' }])
const said = (at: Date, text: string) => JSON.stringify({ type: 'assistant', timestamp: at.toISOString(), message: { role: 'assistant', content: [{ type: 'text', text }], stop_reason: 'end_turn' } })
const tsOf = (at: Date) => row(at, 'x').ts
const steps = async (id: string, ts: string) => {
  const res = await fetch(`${base}/api/sessions/${encodeURIComponent(id)}/turn-steps?ts=${encodeURIComponent(ts)}&days=2`)
  return { status: res.status, text: await res.clone().text(), body: (await res.json()) as TurnStepsResponse }
}

before(async () => {
  process.env.AGENT_FEED_HOST = 'testmac'
  dir = await mkdtemp(join(tmpdir(), 'sai-turn-steps-'))
  const feedDir = join(dir, 'feed')
  const projectDir = join(dir, 'projects', claudeProjectName(dir))
  const rolloutDir = join(dir, 'codex', String(now.getFullYear()), String(now.getMonth() + 1).padStart(2, '0'), String(now.getDate()).padStart(2, '0'))
  await mkdir(feedDir)
  await mkdir(projectDir, { recursive: true })
  await mkdir(rolloutDir, { recursive: true })
  await writeFile(join(projectDir, 'C1.jsonl'), [
    user(ago(40), '最初の指示'), use(ago(39), 'Read', { file_path: '/w/README.md' }), out(ago(39)), said(ago(38), '読みました'),
    user(ago(30), 'テストを回して'), use(ago(29), 'Bash', { command: 'pnpm test', description: 'テスト' }), out(ago(28)), use(ago(27), 'Edit', { file_path: '/w/a.ts' }), out(ago(27)), said(ago(26), '直しました'),
    // 自分で起きたターン（入力の行は無い）
    user(ago(20), '<task-notification>done</task-notification>'), use(ago(19), 'Bash', { command: 'git status' }), out(ago(19)), said(ago(18), '確認しました'),
  ].join('\n') + '\n')
  await writeFile(join(projectDir, 'R1.jsonl'), [user(ago(30), 'x'), use(ago(29), 'Bash', { command: 'ls' }), said(ago(26), 'y')].join('\n') + '\n')
  const ev = (at: Date, type: string) => JSON.stringify({ timestamp: at.toISOString(), type: 'event_msg', payload: { type } })
  await writeFile(join(rolloutDir, 'rollout-2026-10-02T00-00-00-X1.jsonl'), [
    ev(ago(30), 'task_started'),
    JSON.stringify({ timestamp: ago(29).toISOString(), type: 'response_item', payload: { type: 'function_call', name: 'shell', call_id: 'c', arguments: '{"command":["bash","-lc","cargo test"]}' } }),
    JSON.stringify({ timestamp: ago(28).toISOString(), type: 'response_item', payload: { type: 'function_call_output', call_id: 'c', output: 'SECRET' } }),
    ev(ago(26), 'task_complete'),
  ].join('\n') + '\n')
  const c = { repo: 'r', cwd: dir, agent: 'claude' } as const
  const lines = [
    row(ago(38), 'C1', { ...c, user_text: '最初の指示', text: '読みました' }),
    row(ago(30), 'C1', { ...c, event: 'UserPromptSubmit', user_text: 'テストを回して', text: '' }),
    row(ago(26), 'C1', { ...c, user_text: 'テストを回して', text: '直しました' }),
    row(ago(18), 'C1', { ...c, user_text: '', text: '確認しました' }),
    row(ago(5), 'C1', { ...c, user_text: '要約で消えたターン', text: '古い返答' }),
    row(ago(26), 'R1', { ...c, host: 'far-away-machine', text: 'y' }),
    row(ago(26), 'X1', { repo: 'r', cwd: dir, agent: 'codex', session_source: 'rollout', text: '終わりました' }),
    row(ago(26), 'O1', { repo: 'r', cwd: dir, agent: 'opencode', text: '終わり' }),
    row(ago(26), 'N1', { ...c, text: 'transcript が無い' }),
  ]
  await writeFile(join(feedDir, `${localDate(now.toISOString())}.jsonl`), lines.map((l) => JSON.stringify(l)).join('\n') + '\n')
  const app = createApp(
    new FeedStore(feedDir), join(dir, 'dist'), undefined, new Approvals(), undefined, undefined, undefined,
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

test('Claude: その行のターンの手順だけを返す（前後のターンのものは混ぜない）。出力は返さない', async () => {
  const got = await steps('C1@r', tsOf(ago(26)))
  assert.equal(got.status, 200)
  assert.equal(got.body.found, true)
  assert.deepEqual(got.body.steps.map((s) => [s.tool, s.summary, s.note]), [['Bash', 'pnpm test', 'テスト'], ['Edit', '/w/a.ts', undefined]])
  assert.equal(got.body.total, 2)
  assert.equal(got.text.includes('SECRET'), false)
  assert.deepEqual((await steps('C1@r', tsOf(ago(38)))).body.steps.map((s) => s.summary), ['/w/README.md'], '入力の行が無いターンは終わりの時刻で当てる')
  assert.deepEqual((await steps('C1@r', tsOf(ago(18)))).body.steps.map((s) => s.summary), ['git status'], '自分で起きたターン')
})

test('Codex: rollout の task_started〜task_complete の手順', async () => {
  const got = await steps('X1@r', tsOf(ago(26)))
  assert.deepEqual([got.body.found, got.body.steps.map((s) => [s.tool, s.summary])], [true, [['shell', 'cargo test']]])
  assert.equal(got.text.includes('SECRET'), false)
})

test('引けないターン・別のマシン・OpenCode・transcript 無し・無い行は found: false で空。ts 無しは 400、窓に無いセッションは 404', async () => {
  for (const [id, ts] of [['C1@r', tsOf(ago(5))], ['R1@r', tsOf(ago(26))], ['O1@r', tsOf(ago(26))], ['N1@r', tsOf(ago(26))], ['C1@r', tsOf(ago(99))]] as const) {
    const got = await steps(id, ts)
    assert.deepEqual([got.status, got.body.found, got.body.steps, got.body.total], [200, false, [], 0], id)
  }
  assert.equal((await fetch(`${base}/api/sessions/C1%40r/turn-steps`)).status, 400)
  assert.equal((await steps('nope@r', tsOf(ago(26)))).status, 404)
  assert.equal((await fetch(`${base}/api/sessions/C1%40r/turn-steps?ts=x`, { method: 'POST' })).status, 405)
})
