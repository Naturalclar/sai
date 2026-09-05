import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import type { Server } from 'node:http'
import { appendFile, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ReplyResponse, SessionsResponse } from '../shared/types.ts'
import { createApp } from './app.ts'
import { Approvals } from './approvals.ts'
import { localDate } from './aggregate.ts'
import { row } from './aggregate.test.ts'
import { FeedStore } from './store.ts'
import { BuildFreshness } from './buildFreshness.ts'
import { Authenticator } from './auth.ts'
import { TerminalReplies } from './terminal.ts'
import type { Tmux } from './terminal.ts'
import type { ReplyCommand, Runner } from './runner.ts'

let dir: string
let server: Server
let base: string
let feedFile: string
/** 行の cwd。フィードのディレクトリの下に置くと store が「SAI 自身の雑音」として読み飛ばすので、別の場所 */
let work: string
const started: { id: string; cmd: ReplyCommand }[] = []
const runner: Runner = { running: () => false, snapshot: () => ({}), async start(id, cmd) { started.push({ id, cmd }) } }

const IDLE = '──────\n❯ Try "refactor <filepath>"\n──────\n'
class FakeTmux implements Tmux {
  calls: string[][] = []
  screen = IDLE
  paneExists = true
  async run(args: string[]): Promise<string> {
    this.calls.push(args)
    if (args[0] === 'display-message') {
      if (!this.paneExists) throw new Error('no pane')
      return '100\n'
    }
    if (args[0] === 'capture-pane') return this.screen
    return ''
  }
}
const tmux = new FakeTmux()
const alivePids = new Set([200])
const now = new Date()
const min = (n: number) => n * 60_000

before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'sai-term-'))
  work = await mkdtemp(join(tmpdir(), 'sai-term-work-'))
  feedFile = join(dir, `${localDate(now.toISOString())}.jsonl`)
  await writeFile(
    feedFile,
    [
      // 端末で開いている（pane あり、pid 200 は生きている）
      JSON.stringify(row(new Date(now.getTime() - min(5)), 'T1', { repo: 'r', cwd: work, pane: '%9', pid: 200 })),
      // 端末は閉じた（pid 300 は死んでいる）
      JSON.stringify(row(new Date(now.getTime() - min(4)), 'D1', { repo: 'r', cwd: work, pane: '%8', pid: 300 })),
      // 旧形式（pane 無し）
      JSON.stringify(row(new Date(now.getTime() - min(3)), 'P1', { repo: 'r', cwd: work })),
    ].join('\n') + '\n',
  )
  const app = createApp(
    new FeedStore(dir),
    join(dir, 'dist'),
    runner,
    new Approvals(),
    new BuildFreshness(join(dir, 'dist'), [], 0),
    undefined,
    new Authenticator(async () => null),
    { tmux, ps: async () => ' 100     1\n 200   100\n', replies: new TerminalReplies(), alive: (pid) => alivePids.has(pid) },
  )
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

const post = (id: string, text: string) =>
  fetch(`${base}/api/sessions/${encodeURIComponent(id)}/reply?days=30`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: base },
    body: JSON.stringify({ text }),
  })
const sessions = async () => (await (await fetch(`${base}/api/sessions?days=30`)).json()) as SessionsResponse

test('一覧: pid が生きていて pane があるセッションだけ terminal が付く', async () => {
  const data = await sessions()
  const by = Object.fromEntries(data.sessions.map((s) => [s.id, s.terminal]))
  assert.deepEqual(by['T1@r'], { pane: '%9', pid: 200 })
  assert.equal(by['D1@r'], null, 'pid が死んでいる')
  assert.equal(by['P1@r'], null, 'pane が無い')
})

test('返信: 端末で開いていればペインに打ち込み（via terminal）、ターン完了の行が届くまで処理中', async () => {
  tmux.calls.length = 0
  started.length = 0
  let res = await post('T1@r', '続きをやって')
  assert.equal(res.status, 202)
  const data = (await res.json()) as ReplyResponse
  assert.equal(data.via, 'terminal')
  assert.deepEqual(tmux.calls.map((c) => c[0]), ['display-message', 'capture-pane', 'load-buffer', 'paste-buffer', 'send-keys'])
  assert.equal(started.length, 0, '-p は立てない')

  let list = await sessions()
  assert.equal(list.replying['T1@r']?.text, '続きをやって')
  res = await post('T1@r', 'もう一度')
  assert.equal(res.status, 409, '処理中は二重に打ち込まない')

  // フックがターン完了の行を足したら終わり
  await appendFile(feedFile, JSON.stringify(row(new Date(), 'T1', { repo: 'r', cwd: work, pane: '%9', pid: 200, user_text: '続きをやって', text: 'やった' })) + '\n')
  list = await sessions()
  assert.equal(list.replying['T1@r'], undefined)
})

test('返信: 入力中・ダイアログ中は 409 で何も打たない', async () => {
  tmux.calls.length = 0
  tmux.screen = IDLE.replace('❯ Try "refactor <filepath>"', '❯ 打ちかけ')
  const res = await post('T1@r', 'x')
  assert.equal(res.status, 409)
  assert.match(((await res.json()) as { error: string }).error, /打ちかけ/)
  assert.equal(tmux.calls.some((c) => c[0] === 'paste-buffer'), false)
  tmux.screen = IDLE
})

test('返信: ペインが消えていれば -p にフォールバック。端末で開いていないセッションも -p', async () => {
  tmux.paneExists = false
  started.length = 0
  let res = await post('T1@r', 'x')
  assert.equal(res.status, 202)
  assert.equal(((await res.json()) as ReplyResponse).via, 'process')
  assert.equal(started.length, 1)
  tmux.paneExists = true
  res = await post('D1@r', 'y')
  assert.equal(((await res.json()) as ReplyResponse).via, 'process')
})
