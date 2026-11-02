// Codex の daemon を読むだけで見る口（#848）と「空き」の判定・設定のつながり。本物の createApp に偽の口を渡す。本物のソケットには繋がない
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import type { Server } from 'node:http'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentSessionsResponse, Replying, SettingsResponse } from '../shared/types.ts'
import { createApp } from './app.ts'
import { Approvals } from './approvals/approvals.ts'
import { Authenticator } from './auth.ts'
import { FakeWorkGit } from './git/workStateFake.ts'
import { BuildFreshness } from './local/buildFreshness.ts'
import { AGENT_TOKEN_FILE } from './reply/agentMessages.ts'
import { CODEX_DAEMON_LOG } from './reply/codexDaemon.ts'
import type { CodexDaemonWatch, DaemonThreadState } from './reply/codexDaemon.ts'
import type { ReplyCommand, Runner } from './reply/runner.ts'
import { localDate } from './rows/aggregate.ts'
import { row } from './rows/aggregate.test.ts'
import { FeedStore } from './rows/store.ts'

let dir: string
let work: string
let server: Server
let base: string
let token: string

class FakeRunner implements Runner {
  started: { id: string; cmd: ReplyCommand }[] = []
  busy = new Map<string, Replying>()
  running(id: string) {
    return this.busy.has(id)
  }
  snapshot() {
    return Object.fromEntries(this.busy)
  }
  async start(id: string, cmd: ReplyCommand) {
    this.started.push({ id, cmd })
  }
}
const runner = new FakeRunner()
const git = new FakeWorkGit()

const daemonStates = new Map<string, DaemonThreadState>()
const daemonEnabled: boolean[] = []
const codexDaemon: CodexDaemonWatch = {
  setEnabled: (on) => void daemonEnabled.push(on),
  link: () => (daemonEnabled.at(-1) ? 'connected' : 'off'),
  state: (id) => daemonStates.get(id),
  stop: () => {},
}

before(async () => {
  process.env.AGENT_FEED_HOST = 'testmac'
  dir = await mkdtemp(join(tmpdir(), 'sai-daemon-holding-'))
  work = await mkdtemp(join(tmpdir(), 'sai-daemon-holding-work-'))
  const now = new Date()
  const base0 = { repo: 'r', cwd: work, project: 'o/repo-x' }
  await writeFile(
    join(dir, `${localDate(now.toISOString())}.jsonl`),
    [
      row(new Date(now.getTime() - 9 * 60_000), 'A1', { ...base0, user_text: '割り振って' }),
      row(new Date(now.getTime() - 8 * 60_000), 'B1', { ...base0, user_text: '直して', text: '直しました' }),
      row(new Date(now.getTime() - 7 * 60_000), 'X1', { ...base0, agent: 'codex', session_source: 'rollout', user_text: '見て', text: '見ました' }),
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
    new Authenticator(async () => null),
    { tmux: { run: async () => { throw new Error('unused') } }, ps: async () => '', codexDaemon },
    undefined,
    git,
  )
  token = (await readFile(join(dir, AGENT_TOKEN_FILE), 'utf-8')).trim()
  server = createServer((req, res) => void app(req, res))
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const addr = server.address()
  base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`
})

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
  await rm(dir, { recursive: true, force: true })
  await rm(work, { recursive: true, force: true })
})

const holdingOf = async (id: string) => {
  runner.busy.set('A1@r', { since: `${Date.now()}-${Math.random()}`, text: 'やって' })
  try {
    const res = await fetch(`${base}/api/agent/sessions?from=A1%40r`, { headers: { 'X-SAI-Agent-Token': token } })
    assert.equal(res.status, 200)
    return ((await res.json()) as AgentSessionsResponse).sessions.find((s) => s.id === id)?.holding
  } finally {
    runner.busy.delete('A1@r')
  }
}

test('daemon の状態は「空きでない」にだけ使う。idle では空きと言わず、今の判定と食い違えば変わったときだけ記録する（#848）', async () => {
  git.states.set(work, 'clean')
  assert.equal((await holdingOf('X1@r'))?.free, true, '状態が無いときは今までどおり')
  daemonStates.set('X1', 'active')
  assert.equal((await holdingOf('X1@r'))?.why, 'busy')
  await holdingOf('X1@r')
  daemonStates.set('X1', 'waiting')
  assert.equal((await holdingOf('X1@r'))?.why, 'waiting')
  daemonStates.set('X1', 'idle')
  assert.equal((await holdingOf('X1@r'))?.free, true)
  git.states.set(work, 'dirty')
  assert.equal((await holdingOf('X1@r'))?.why, 'dirty', 'idle は空きの証拠にならない')
  daemonStates.set('B1', 'active')
  assert.equal((await holdingOf('B1@r'))?.why, 'dirty', 'Claude のセッションには使わない')
  await new Promise((r) => setTimeout(r, 30))
  const lines = (await readFile(join(dir, CODEX_DAEMON_LOG), 'utf-8')).trim().split('\n').map((l) => JSON.parse(l) as { id: string; gap: string })
  assert.deepEqual(lines.map((l) => [l.id, l.gap]), [['X1@r', 'daemon_only']], 'active → waiting は同じ食い違いなので 1 行')
  daemonStates.clear()
})

test('settings: 既定は切で、起動で切を渡す。PUT の入切が daemon に渡り、繋がりを返す（#848）', async () => {
  assert.equal(daemonEnabled[0], false)
  const put = (body: object) => fetch(`${base}/api/settings`, { method: 'PUT', headers: { 'Content-Type': 'application/json', Origin: base }, body: JSON.stringify(body) })
  const shown = (await (await fetch(`${base}/api/settings`)).json()) as SettingsResponse
  assert.equal(shown.codex_daemon, false)
  assert.equal(shown.codex_daemon_link, 'off')
  assert.equal((await put({ codex_daemon: 'yes' })).status, 400)
  assert.equal(daemonEnabled.length, 1)
  const on = (await (await put({ codex_daemon: true })).json()) as SettingsResponse
  assert.equal(daemonEnabled.at(-1), true)
  assert.equal(on.codex_daemon, true)
  assert.equal(on.codex_daemon_link, 'connected')
  await put({ codex_daemon: false })
  assert.equal(daemonEnabled.at(-1), false)
})
