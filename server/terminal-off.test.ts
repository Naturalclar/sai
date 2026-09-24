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
import { createApp } from './app.ts'
import { FeedStore } from './rows/store.ts'
import { localDate } from './rows/aggregate.ts'
import { row } from './rows/aggregate.test.ts'
import type { PaneCodex } from './reply/codexPanes.ts'

/** 呼ばれたら数える（呼ばれないことを見るので、中身は空でよい） */
const panes = {
  scans: 0,
  async scan(): Promise<PaneCodex[]> {
    panes.scans++
    return []
  },
}
/** 呼ばれたら落ちる tmux（SAI_TERMINAL=0 では 1 回も触らないはず） */
const tmux = { async run(): Promise<string> { throw new Error('tmux を呼んではいけない') } }

let dir: string
let server: Server
let base: string
let saved: string | undefined

before(async () => {
  saved = process.env.SAI_TERMINAL
  process.env.SAI_TERMINAL = '0'
  dir = await mkdtemp(join(tmpdir(), 'sai-term-off-'))
  const feedDir = join(dir, 'feed')
  await mkdir(feedDir)
  const now = new Date()
  // 端末で開いていることになっている Codex の行（pane / pid 付き）。見に行く条件は揃えておく
  const line = JSON.stringify(row(now, 'X1', { agent: 'codex', repo: 'r', pane: '%1', pid: process.pid, session_source: 'rollout' }))
  await writeFile(join(feedDir, `${localDate(now.toISOString())}.jsonl`), `${line}\n`)

  const store = new FeedStore(feedDir)
  const app = createApp(store, join(dir, 'dist'), undefined, undefined, undefined, undefined, undefined, { tmux, ps: async () => '', codexPanes: panes })
  server = createServer((req, res) => void app(req, res))
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const addr = server.address()
  base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`
})

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
  await rm(dir, { recursive: true, force: true })
  if (saved === undefined) delete process.env.SAI_TERMINAL
  else process.env.SAI_TERMINAL = saved
})

test('SAI_TERMINAL=0: 一覧・フィード・詳細を組んでもペインを走査しない（#435）', async () => {
  panes.scans = 0
  for (const path of ['/api/sessions?days=7', '/api/feed?days=7', '/api/sessions/X1%40r']) {
    assert.equal((await fetch(`${base}${path}`)).status, 200, path)
  }
  assert.equal(panes.scans, 0, 'tmux を見る経路に入らない')
})

test('SAI_TERMINAL=0: 端末に打ち込まないので、返信は別プロセスの経路に落ちる（#435 のついで）', async () => {
  panes.scans = 0
  // 返信そのものは起動しない（runner を渡していないので 500 になる）。ここで見るのは「ペインを探しに行かない」こと
  await fetch(`${base}/api/sessions/X1%40r/reply`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: base },
    body: JSON.stringify({ text: 'やって' }),
  })
  assert.equal(panes.scans, 0)
})
