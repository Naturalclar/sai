// SAI_TERMINAL=0 のとき、tmux を見る経路に 1 本も入らないこと（#435 の 2 つ目）。
// ペインの走査（CodexPanes）は TTL を持っているが、**そもそも呼ばれない**ことをここで留める
// （呼ばれていれば、tmux の無いマシンでも 30 秒に 1 回は起こしてしまう）。
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import type { Server } from 'node:http'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ReplyingMap, ReplyResponse } from '../shared/types.ts'
import { createApp } from './app.ts'
import { FeedStore } from './rows/store.ts'
import { localDate } from './rows/aggregate.ts'
import { row } from './rows/aggregate.test.ts'
import type { PaneCodex } from './reply/codexPanes.ts'
import type { ReplyCommand, Runner } from './reply/runner.ts'

/** 呼ばれたら数える（呼ばれないことを見るので、中身は空でよい） */
const panes = {
  scans: 0,
  async scan(): Promise<PaneCodex[]> {
    panes.scans++
    return []
  },
}
/** 呼ばれたら数える tmux。SAI_TERMINAL=0 では 1 回も触らないはず（打ち込みの経路に入れば数が増える） */
const tmux = {
  calls: 0,
  async run(): Promise<string> {
    tmux.calls++
    return ''
  },
}
/** 開いている Codex への `codex queue` の代わり（本物を起こさない） */
const queued: ReplyCommand[] = []
/** `-p` の代わり（本物の ProcessRunner を立てない） */
const runner: Runner = {
  running: () => false,
  snapshot: (): ReplyingMap => ({}),
  start: async () => {},
}

let dir: string
let server: Server
let base: string
const saved: Record<string, string | undefined> = {}

before(async () => {
  for (const key of ['SAI_TERMINAL', 'SAI_CODEX_APP_SERVER']) saved[key] = process.env[key]
  process.env.SAI_TERMINAL = '0'
  // app-server を起こさない（閉じた Codex の経路に落ちても子を立てないように）
  process.env.SAI_CODEX_APP_SERVER = '0'
  dir = await mkdtemp(join(tmpdir(), 'sai-term-off-'))
  const feedDir = join(dir, 'feed')
  const cwd = join(dir, 'work')
  await mkdir(feedDir)
  await mkdir(cwd)
  const now = new Date()
  // 端末で開いていることになっている Codex の行（pane と**生きている** pid 付き）。
  // SAI_TERMINAL が効いていなければ、返信はこのペインへ打ち込みに行く
  const line = JSON.stringify(row(now, 'X1', { agent: 'codex', repo: 'r', cwd, pane: '%1', pid: process.pid, session_source: 'rollout' }))
  await writeFile(join(feedDir, `${localDate(now.toISOString())}.jsonl`), `${line}\n`)

  const store = new FeedStore(feedDir)
  const app = createApp(store, join(dir, 'dist'), runner, undefined, undefined, undefined, undefined, {
    tmux,
    ps: async () => '',
    codexPanes: panes,
    codexWriterActive: async () => false,
    codexQueue: async (cmd) => {
      queued.push(cmd)
    },
  })
  server = createServer((req, res) => void app(req, res))
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const addr = server.address()
  base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`
})

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
  await rm(dir, { recursive: true, force: true })
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
})

test('SAI_TERMINAL=0: 一覧・フィード・詳細を組んでもペインを走査しない（#435）', async () => {
  panes.scans = 0
  tmux.calls = 0
  for (const path of ['/api/sessions?days=7', '/api/feed?days=7', '/api/sessions/X1%40r']) {
    assert.equal((await fetch(`${base}${path}`)).status, 200, path)
  }
  assert.equal(panes.scans, 0, 'tmux を見る経路に入らない')
  assert.equal(tmux.calls, 0)
})

test('SAI_TERMINAL=0: 端末で開いている Codex への返信も、ペインに打ち込まず queue に回す（#435）', async () => {
  panes.scans = 0
  tmux.calls = 0
  queued.length = 0
  const res = await fetch(`${base}/api/sessions/X1%40r/reply`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: base },
    body: JSON.stringify({ text: 'やって' }),
  })
  assert.equal(res.status, 202, '受け付ける（端末を使わない経路で）')
  assert.equal(((await res.json()) as ReplyResponse).via, 'queue', '開いている Codex なので queue に回る')
  assert.equal(queued.length, 1)
  assert.equal(tmux.calls, 0, 'ペインに打ち込まない（SAI_TERMINAL=0）')
  assert.equal(panes.scans, 0, 'ペインを探しにも行かない')
})
