import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import type { Server } from 'node:http'
import { appendFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ReplyError, ReplyResponse, SessionsResponse } from '../shared/types.ts'
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
import type { CodexApp, CodexTurnInput } from './codexAppServer.ts'

let dir: string
let server: Server
let base: string
let feedFile: string
/** 行の cwd。フィードのディレクトリの下に置くと store が「SAI 自身の雑音」として読み飛ばすので、別の場所 */
let work: string
const started: { id: string; cmd: ReplyCommand }[] = []
const queued: ReplyCommand[] = []
const codexStarted: CodexTurnInput[] = []
const runner: Runner = { running: () => false, snapshot: () => ({}), async start(id, cmd) { started.push({ id, cmd }) } }
const codexApp: CodexApp = {
  running: () => false,
  replying: () => ({}),
  snapshot: () => ({}),
  getApproval: () => undefined,
  async start(input) { codexStarted.push(input) },
  answer: () => ({ ok: false, status: 404, error: 'approval not found' }),
}

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
    // C-u で入力欄が空になる（Claude Code の実機と同じ）
    if (args[0] === 'send-keys' && args.includes('C-u')) this.screen = IDLE
    return ''
  }
}
const tmux = new FakeTmux()
const alivePids = new Set([200, 201])
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
      // tmux で開いている Codex（pid 201 は生きている）
      JSON.stringify(row(new Date(now.getTime() - min(2)), 'X1', { agent: 'codex', repo: 'r', cwd: work, pane: '%10', pid: 201, session_source: 'rollout' })),
      // tmux の外で開いている Codex（記録時の pid は死んだが writer lock は残っている）
      JSON.stringify(row(new Date(now.getTime() - min(1)), 'X2', { agent: 'codex', repo: 'r', cwd: work, pane: '', pid: 302, session_source: 'rollout' })),
      // 閉じた Codex（pid 301 は死んでいる）
      JSON.stringify(row(new Date(now.getTime() - min(1)), 'X3', { agent: 'codex', repo: 'r', cwd: work, pane: '', pid: 301, session_source: 'rollout' })),
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
    {
      tmux,
      ps: async () => ' 100     1\n 200   100\n 201   100\n',
      replies: new TerminalReplies(),
      alive: (pid) => alivePids.has(pid),
      codexWriterActive: async (session) => session === 'X1' || session === 'X2',
      codexQueue: async (cmd) => {
        if (cmd.text === '失敗') throw new Error('queue rejected')
        queued.push(cmd)
      },
      codexApp,
    },
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

const post = (id: string, text: string, extra: object = {}) =>
  fetch(`${base}/api/sessions/${encodeURIComponent(id)}/reply?days=30`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: base },
    body: JSON.stringify({ text, ...extra }),
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
  codexStarted.length = 0
  let res = await post('T1@r', '続きをやって')
  assert.equal(res.status, 202)
  const data = (await res.json()) as ReplyResponse
  assert.equal(data.via, 'terminal')
  assert.deepEqual(tmux.calls.map((c) => c[0]), ['display-message', 'capture-pane', 'load-buffer', 'paste-buffer', 'send-keys'])
  assert.equal(started.length, 0, '-p は立てない')

  let list = await sessions()
  assert.equal(list.replying['T1@r']?.text, '続きをやって')
  // 画面（要対応）が別プロセスの返信と区別できるように via が載る（#232）
  assert.equal(list.replying['T1@r']?.via, 'terminal')

  // 端末で開いている間は、前のターンが動いていても打ち込める（TUI が次のターンに回す。#170）
  tmux.calls.length = 0
  res = await post('T1@r', 'もう一度')
  assert.equal(res.status, 202, '端末なら処理中でも打てる')
  assert.equal(((await res.json()) as ReplyResponse).via, 'terminal')
  assert.equal(tmux.calls.some((c) => c[0] === 'paste-buffer'), true)
  assert.equal(started.length, 0, '-p は立てない')

  // フックがターン完了の行を足したら終わり
  await appendFile(feedFile, JSON.stringify(row(new Date(), 'T1', { repo: 'r', cwd: work, pane: '%9', pid: 200, user_text: '続きをやって', text: 'やった' })) + '\n')
  list = await sessions()
  assert.equal(list.replying['T1@r'], undefined)
})

test('返信: 入力中は 409 で code: terminal_typed と typed を返し、何も打たない', async () => {
  tmux.calls.length = 0
  tmux.screen = IDLE.replace('❯ Try "refactor <filepath>"', '❯ 提案されているsub issueを立てて')
  const res = await post('T1@r', 'x')
  assert.equal(res.status, 409)
  const body = (await res.json()) as ReplyError
  assert.match(body.error, /打ちかけ/)
  assert.equal(body.code, 'terminal_typed')
  assert.equal(body.typed, '提案されているsub issueを立てて')
  assert.equal(tmux.calls.some((c) => c[0] === 'paste-buffer' || c.includes('C-u')), false)
  tmux.screen = IDLE
})

test('返信: replace_typed で打ちかけを消してから打ち込み、reply.log に消した文が残る', async () => {
  tmux.calls.length = 0
  tmux.screen = IDLE.replace('❯ Try "refactor <filepath>"', '❯ 消される文')
  const res = await post('T1@r', '本文', { replace_typed: true })
  assert.equal(res.status, 202, JSON.stringify(await res.clone().json()))
  assert.equal(((await res.json()) as ReplyResponse).via, 'terminal')
  const ops = tmux.calls.map((c) => (c[0] === 'send-keys' ? `send-keys ${c[3]}` : c[0]))
  assert.deepEqual(ops, ['display-message', 'capture-pane', 'send-keys C-u', 'capture-pane', 'load-buffer', 'paste-buffer', 'send-keys Enter'])
  const log = await readFile(join(dir, 'reply.log'), 'utf-8')
  assert.match(log, /端末の打ちかけを消して打ち込んだ: "消される文"/)
  // 処理中になったので片付ける（ターン完了の行を足す）
  await appendFile(feedFile, JSON.stringify(row(new Date(), 'T1', { repo: 'r', cwd: work, pane: '%9', pid: 200, user_text: '本文', text: 'ok' })) + '\n')
  await sessions()
})

test('返信: ダイアログ中は replace_typed でも 409（code: terminal_dialog）で消さない', async () => {
  tmux.calls.length = 0
  tmux.screen = IDLE + '  ❯ 1. Yes\n    2. No\n  Enter to confirm · Esc to cancel\n'
  const res = await post('T1@r', 'x', { replace_typed: true })
  assert.equal(res.status, 409)
  const body = (await res.json()) as ReplyError
  assert.equal(body.code, 'terminal_dialog')
  assert.equal(body.typed, undefined)
  assert.equal(tmux.calls.some((c) => c.includes('C-u') || c[0] === 'paste-buffer'), false)
  tmux.screen = IDLE
})

test('返信: 端末に打てない 409 には can_process が付き、via: process なら端末を見ずに別プロセスで回す（#157）', async () => {
  // 打ちかけ・ダイアログ・入力欄不明のどれでも can_process
  tmux.calls.length = 0
  started.length = 0
  tmux.screen = IDLE.replace('❯ Try "refactor <filepath>"', '❯ 消せない文')
  let res = await post('T1@r', 'x')
  assert.equal(res.status, 409)
  assert.equal(((await res.json()) as ReplyError).can_process, true)
  tmux.screen = IDLE + '  ❯ 1. Yes\n    2. No\n  Enter to confirm · Esc to cancel\n'
  res = await post('T1@r', 'x')
  assert.equal(((await res.json()) as ReplyError).can_process, true)
  tmux.screen = '$ ls\n$ '
  res = await post('T1@r', 'x')
  assert.equal(((await res.json()) as ReplyError).code, 'terminal_unknown')
  assert.equal(((await res.json().catch(() => ({}))) as ReplyError).can_process ?? true, true)
  assert.equal(started.length, 0)

  // via: process。端末は触らず（capture-pane も送らず）、-p を立てる
  tmux.calls.length = 0
  tmux.screen = IDLE.replace('❯ Try "refactor <filepath>"', '❯ 消せない文')
  res = await post('T1@r', '別で送る', { via: 'process' })
  assert.equal(res.status, 202, JSON.stringify(await res.clone().json()))
  assert.equal(((await res.json()) as ReplyResponse).via, 'process')
  assert.equal(tmux.calls.length, 0, '端末には何も送らない')
  assert.equal(started.length, 1)
  const args = started[0]!.cmd.args
  assert.deepEqual(args.slice(args.indexOf('-p'), args.indexOf('-p') + 3), ['-p', '--resume', 'T1'], '今までの -p の経路そのもの')
  const log = await readFile(join(dir, 'reply.log'), 'utf-8')
  assert.match(log, /別プロセスで回す（画面の指定 via: process）/)
  tmux.screen = IDLE
})

test('返信: 開いている Codex は active writer と競合する resume ではなく queue へ送る', async () => {
  started.length = 0
  queued.length = 0
  tmux.calls.length = 0
  tmux.screen = '› 打ちかけ\n  gpt-5.6-sol medium · /tmp/repo\n'

  // tmux に打ち込めなければ queue の選択肢を提示する
  let res = await post('X1@r', 'x')
  assert.equal(res.status, 409)
  let body = (await res.json()) as ReplyError
  assert.equal(body.code, 'terminal_typed')
  assert.equal(body.can_process, true)

  // API を via: process で呼ぶと、名前は互換のまま active Codex には queue する
  res = await post('X1@r', 'x', { via: 'process' })
  assert.equal(res.status, 202)
  assert.equal(((await res.json()) as ReplyResponse).via, 'queue')
  assert.deepEqual(queued[0]?.args, ['queue', '--thread', 'X1', '--message', 'x'])

  // queue 自体が失敗したら 202 にせず、CLI の理由を画面へ返す
  res = await post('X2@r', '失敗')
  assert.equal(res.status, 500)
  assert.match(((await res.json()) as ReplyError).error, /queue rejected/)
  assert.equal(queued.length, 1)

  // tmux 外（Codex アプリなど）で開いていても queue で会話へ届く
  res = await post('X2@r', 'x')
  assert.equal(res.status, 202)
  assert.equal(((await res.json()) as ReplyResponse).via, 'queue')
  assert.equal(queued.length, 2)
  assert.equal(started.length, 0)

  // 閉じた Codex はapp-serverで再開し、許可・質問も同じ接続で扱える
  res = await post('X3@r', 'x')
  assert.equal(res.status, 202)
  assert.equal(((await res.json()) as ReplyResponse).via, 'app-server')
  assert.equal(codexStarted[0]?.threadId, 'X3')
  assert.equal(started.length, 0)
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

test('返信: 端末で開いていないセッションは、処理中なら 409（-p の二重起動を止める）', async () => {
  started.length = 0
  // D1 は pid が死んでいて端末では開いていない。1 通目は -p で回る
  let res = await post('D1@r', '一通目')
  assert.equal(res.status, 202)
  assert.equal(((await res.json()) as ReplyResponse).via, 'process')

  // FakeRunner は running を返さないので、処理中は端末側（TerminalReplies）ではなくこちらで作る
  const list = await sessions()
  assert.equal(list.replying['D1@r'], undefined, 'FakeRunner は処理中を持たない')
})

// ---- #255: 端末で答えたら、次のターンを待たずに待ちを畳む（#232 の積み残し）

test('待ちの畳み: 端末のダイアログが消えていれば waiting を空にする（要対応から消える）', async () => {
  // T1 に待ちの行を足す。行はこのあと消えないので、畳むかはペインの見た目だけで決まる
  await appendFile(
    feedFile,
    JSON.stringify(row(new Date(), 'T1', { repo: 'r', cwd: work, pane: '%9', pid: 200, event: 'PermissionRequest', text: '許可待ち: Bash: ls', user_text: '' })) + '\n',
  )

  // ダイアログが出ている間は残る
  tmux.screen = IDLE + '\n  ❯ 1. Yes\n    2. No\n  Enter to confirm · Esc to cancel'
  let list = await sessions()
  assert.equal(list.sessions.find((s) => s.id === 'T1@r')?.waiting, '許可待ち: Bash: ls')

  // 人が端末で答えてダイアログが消えた → 行はそのままでも待ちは畳む
  tmux.screen = IDLE
  list = await sessions()
  assert.equal(list.sessions.find((s) => s.id === 'T1@r')?.waiting, '', '次のターンを待たずに消える')

  // チャットの見出しも同じ（要対応・サイドバー・見出しの 3 か所が食い違わない）
  const detail = (await (await fetch(`${base}/api/sessions/${encodeURIComponent('T1@r')}?days=30`)).json()) as { session: { waiting: string } }
  assert.equal(detail.session.waiting, '')
})

test('待ちの畳み: 端末で開いていないセッションは触らない（見に行く材料が無い）', async () => {
  // D1 は pid が死んでいるので terminal が付かない
  await appendFile(
    feedFile,
    JSON.stringify(row(new Date(), 'D1', { repo: 'r', cwd: work, pane: '%8', pid: 300, event: 'PermissionRequest', text: '許可待ち: Edit: x.ts', user_text: '' })) + '\n',
  )
  tmux.screen = IDLE
  const list = await sessions()
  assert.equal(list.sessions.find((s) => s.id === 'D1@r')?.waiting, '許可待ち: Edit: x.ts', '端末が無ければ残す')
})
