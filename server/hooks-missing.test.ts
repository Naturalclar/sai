// 記録に届いていないフックを一覧の応答に載せる（#567）。本物の createApp に偽の読み手を渡して、
// 載る・rev が変わる・分からなければ載らない・このマシンの Claude の行が無ければ言わない・既定では読まない、を見る
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import type { Server } from 'node:http'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { FeedRow, ReplyingMap, SessionsResponse } from '../shared/types.ts'
import { createApp } from './app.ts'
import type { ClaudeHooksReader } from './local/claudeHooks.ts'
import { FeedStore } from './rows/store.ts'
import { localDate } from './rows/aggregate.ts'
import { row } from './rows/aggregate.test.ts'
import type { Runner } from './reply/runner.ts'

const runner: Runner = { running: () => false, snapshot: (): ReplyingMap => ({}), start: async () => {} }

let dir: string
const servers: Server[] = []
const saved: Record<string, string | undefined> = {}

/** 行を書いた feed dir で createApp を立てる。`hooks` を省略すると既定（読まない）のまま */
async function start(rows: FeedRow[], hooks?: ClaudeHooksReader): Promise<string> {
  const feedDir = await mkdtemp(join(dir, 'feed-'))
  await mkdir(feedDir, { recursive: true })
  await writeFile(join(feedDir, `${localDate(new Date().toISOString())}.jsonl`), rows.map((r) => JSON.stringify(r)).join('\n') + '\n')
  const app = createApp(new FeedStore(feedDir), join(dir, 'dist'), runner, undefined, undefined, undefined, undefined, {
    tmux: { run: async () => '' },
    ps: async () => '',
    ...(hooks ? { claudeHooks: hooks } : {}),
  })
  const server = createServer((req, res) => void app(req, res))
  servers.push(server)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const addr = server.address()
  return `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`
}

const sessions = async (base: string): Promise<SessionsResponse> => (await fetch(`${base}/api/sessions`)).json() as Promise<SessionsResponse>

before(async () => {
  for (const key of ['SAI_TERMINAL', 'SAI_CODEX_APP_SERVER', 'SAI_OPENCODE_SERVER', 'AGENT_FEED_HOST']) saved[key] = process.env[key]
  for (const key of ['SAI_TERMINAL', 'SAI_CODEX_APP_SERVER', 'SAI_OPENCODE_SERVER']) process.env[key] = '0'
  process.env.AGENT_FEED_HOST = 'mac'
  dir = await mkdtemp(join(tmpdir(), 'sai-hooks-missing-'))
})

after(async () => {
  for (const server of servers) await new Promise<void>((resolve) => server.close(() => resolve()))
  await rm(dir, { recursive: true, force: true })
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
})

test('hooks_missing: 足りないフックが載り、直すと消えて rev も変わる', async () => {
  let missing: string[] | null = ['SessionEnd']
  const base = await start([row(new Date(), 'S1', { host: 'mac' })], { missing: () => missing })
  const first = await sessions(base)
  assert.deepEqual(first.hooks_missing, ['SessionEnd'])
  missing = []
  const fixed = await sessions(base)
  assert.deepEqual(fixed.hooks_missing, [])
  assert.notEqual(fixed.rev, first.rev, '設定を直したら次の行を待たずに消える')
})

test('hooks_missing: 分からない（null）なら載せない', async () => {
  const base = await start([row(new Date(), 'S1', { host: 'mac' })], { missing: () => null })
  assert.deepEqual((await sessions(base)).hooks_missing, [])
})

test('hooks_missing: このマシンの Claude の行が窓に無ければ言わない', async () => {
  const hooks = { missing: () => ['SessionEnd'] }
  const codexOnly = await start([row(new Date(), 'C1', { agent: 'codex', host: 'mac' })], hooks)
  assert.deepEqual((await sessions(codexOnly)).hooks_missing, [], 'Codex だけ')
  const remote = await start([row(new Date(), 'R1', { host: 'other-mac' })], hooks)
  assert.deepEqual((await sessions(remote)).hooks_missing, [], '別のマシンの Claude だけ')
})

test('hooks_missing: 既定では読まない（本物の ~/.claude/settings.json に触らない）', async () => {
  const base = await start([row(new Date(), 'S1', { host: 'mac' })])
  assert.deepEqual((await sessions(base)).hooks_missing, [])
})
