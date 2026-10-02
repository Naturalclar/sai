// Codex 0.160 の常駐デーモン（`codex app-server --listen unix:// --managed-daemon`）が**ペインの中**にいる形（#653）。
// デーモンは最初の TUI が起こすのでそのペインの子孫になり、notify もデーモンが鳴らすので、回している
// **どのスレッドの行も**同じ pane / pid を指す。本物の createApp と本物の CodexTerminals で、
// 「ペインの子孫だから端末」と読んで別の会話のペインを打ち込み先にしないことを見る
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SessionsResponse } from '../shared/types.ts'
import { createApp } from './app.ts'
import { Approvals } from './approvals/approvals.ts'
import { localDate } from './rows/aggregate.ts'
import { row } from './rows/aggregate.test.ts'
import { FeedStore } from './rows/store.ts'
import { BuildFreshness } from './local/buildFreshness.ts'
import { Authenticator } from './auth.ts'

/** %389 のシェル → TUI → `codex app-server daemon pid-update-loop` → デーモン（実測の並び） */
const SHELL = 9000
const TUI = 9001
const LOOP = 9002
const DAEMON = 9003
const PS = `${SHELL} 1\n${TUI} ${SHELL}\n${LOOP} ${TUI}\n${DAEMON} ${LOOP}\n`

async function terminals(appServer: (pid: number) => Promise<boolean>) {
  const dir = await mkdtemp(join(tmpdir(), 'sai-daemon-'))
  const now = new Date(Date.now() - 5 * 60_000)
  // 同じ worktree の会話が 2 本。%389 が映しているのは B だが、A の行も %389 とデーモンの pid を持つ
  const rows = ['A', 'B'].map((session) => JSON.stringify(row(now, session, { agent: 'codex', repo: 'r', cwd: '/work', pane: '%389', pid: DAEMON, session_source: 'rollout' })))
  await writeFile(join(dir, `${localDate(now.toISOString())}.jsonl`), rows.join('\n') + '\n')
  const app = createApp(
    new FeedStore(dir),
    join(dir, 'dist'),
    { running: () => false, snapshot: () => ({}), async start() {} },
    new Approvals(),
    new BuildFreshness(join(dir, 'dist'), [], 0),
    undefined,
    new Authenticator(async () => null),
    {
      tmux: { run: async (args) => (args[0] === 'display-message' ? `${SHELL}\n` : '') },
      ps: async () => PS,
      alive: () => true,
      codexAppServer: appServer,
      // TUI は rollout を開かず、同じ cwd に 2 本あるので補欠も当てない（`CodexPanes` の側は codexPanes.test.ts）
      codexPanes: { scan: async () => [] },
    },
  )
  const server = createServer((req, res) => void app(req, res))
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const addr = server.address()
  try {
    const res = await fetch(`http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}/api/sessions?days=30`)
    const data = (await res.json()) as SessionsResponse
    return Object.fromEntries(data.sessions.map((s) => [s.id, s.terminal]))
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
    await rm(dir, { recursive: true, force: true })
  }
}

test('行の pid がペインの中の共有デーモンなら、どの会話も端末にしない（#653）', async () => {
  const by = await terminals(async (pid) => pid === LOOP || pid === DAEMON)
  assert.equal(by['A@r'], null, 'A を %389（B を映している）の端末にしない')
  assert.equal(by['B@r'], null, 'デーモンは打ち込む先ではない（TUI の pid は補欠が引く）')
})

test('ペインの中のふつうの Codex（デーモンではない）は今までどおり端末（#653 の対照）', async () => {
  const by = await terminals(async () => false)
  assert.deepEqual(by['A@r'], { pane: '%389', pid: DAEMON })
})
