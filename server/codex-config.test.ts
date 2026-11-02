// Codex を起こす前の確かめ（#856）を、本物の createApp に偽の確かめと app-server を渡して見る。
// どの起こし方（再開・新しいセッション・分岐・レビュー・要約・exec resume）でも、押すまで Codex を起こさない
import { after, before, beforeEach, test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import type { Server } from 'node:http'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CODEX_CONFIG_PAUSED } from '../shared/agentMessages.ts'
import type { CodexConfigAsk, ReplyResponse, SessionDiffResponse, SessionDiffSummaryResponse, SessionsResponse } from '../shared/types.ts'
import { createApp } from './app.ts'
import { Approvals } from './approvals/approvals.ts'
import { Authenticator } from './auth.ts'
import { BuildFreshness } from './local/buildFreshness.ts'
import type { CodexApp } from './reply/codexAppServer.ts'
import type { CodexConfigGate } from './reply/codexConfigGuard.ts'
import { localDate } from './rows/aggregate.ts'
import { row } from './rows/aggregate.test.ts'
import { FeedStore } from './rows/store.ts'
import type { Git } from './git/diff.ts'

const ASK: CodexConfigAsk = { reason: 'found', files: ['sub/.codex/config.toml'], more: 0, note: '', fingerprint: 'fp1' }

let dir: string
let work: string
let server: Server
let base: string
const calls: string[] = []
const spawned: string[] = []
let ask: CodexConfigAsk | null = null
/** `allow()` に渡った指紋 */
const allowed: string[] = []
let allowAnswer: CodexConfigAsk | null = null
const typedInto: string[][] = []
/** `.gitignore` 済みの `.codex/` のファイルとして git が返すもの */
let codexIgnored = ''

const gate: CodexConfigGate = {
  check: async () => ask,
  async allow(_cwd, fingerprint) {
    allowed.push(fingerprint)
    if (allowAnswer) return allowAnswer
    ask = null
    return null
  },
}
/** 処理中にしておくセッション */
const busy = new Set<string>()
const codexApp: CodexApp = {
  running: (id) => busy.has(id),
  replying: () => ({}),
  snapshot: () => ({}),
  getApproval: () => undefined,
  async start(input) {
    calls.push(`start:${input.threadId}`)
  },
  answer: () => ({ ok: false, status: 404, error: 'approval not found' }),
  async review() {
    calls.push('review')
  },
  async compact() {
    calls.push('compact')
  },
  async startThread() {
    calls.push('startThread')
    return 'N1'
  },
  async fork() {
    calls.push('fork')
    return 'F1'
  },
  holds: () => false,
}
const git: Git = {
  async run(cwd, args) {
    if (args[0] === 'worktree') return `worktree ${cwd}\nHEAD abc\nbranch refs/heads/main\n\n`
    if (args[0] === 'rev-parse' && args.includes('--show-toplevel')) return `${cwd}\n`
    if (args[0] === 'rev-parse') return 'abc\n'
    if (args[0] === 'ls-files' && args.includes('--ignored')) return codexIgnored
    return ''
  },
}

before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'sai-codex-config-app-'))
  work = await mkdtemp(join(tmpdir(), 'sai-codex-config-work-'))
  await mkdir(join(work, '.git'))
  const now = new Date(Date.now() - 5 * 60_000)
  const rows = [
    row(now, 'C1', { agent: 'codex', repo: 'r', cwd: work, pane: '', pid: 0, session_source: 'rollout' }),
    row(now, 'C2', { agent: 'codex', repo: 'r', cwd: work, pane: '', pid: 0, session_source: 'rollout' }),
    row(now, 'A1', { agent: 'claude', repo: 'r', cwd: work, pane: '', pid: 0, session_source: 'payload' }),
    // 端末（tmux のペイン）で開いている Codex
    row(now, 'T1', { agent: 'codex', repo: 'r', cwd: work, pane: '%7', pid: 4242, session_source: 'rollout' }),
  ].map((r) => JSON.stringify(r))
  await writeFile(join(dir, `${localDate(now.toISOString())}.jsonl`), rows.join('\n') + '\n')
  const app = createApp(
    new FeedStore(dir),
    join(dir, 'dist'),
    {
      running: () => false,
      snapshot: () => ({}),
      async start(_id, cmd) {
        spawned.push(cmd.bin)
      },
    },
    new Approvals(),
    new BuildFreshness(join(dir, 'dist'), [], 0),
    undefined,
    new Authenticator(async () => null),
    {
      tmux: {
        run: async (args) => {
          if (args[0] === 'send-keys') typedInto.push(args)
          if (args[0] === 'display-message') return '4000\n'
          if (args[0] === 'capture-pane') return '› \n'
          return ''
        },
      },
      ps: async () => '4242 4000\n',
      alive: (pid) => pid === 4242,
      codexAppServer: async () => false,
      codexWriterActive: async () => false,
      codexApp,
      codexConfig: gate,
    },
    undefined,
    git,
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

beforeEach(async () => {
  ask = null
  allowAnswer = null
  allowed.length = 0
  calls.length = 0
  spawned.length = 0
  typedInto.length = 0
})

const post = (path: string, body: unknown, origin = base) =>
  fetch(`${base}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin }, body: JSON.stringify(body) })
const session = (id: string, rest: string) => `/api/sessions/${encodeURIComponent(id)}/${rest}`
const list = async () => (await (await fetch(`${base}/api/sessions?days=30`)).json()) as SessionsResponse
/** 止まっている行を片付ける（テストの間で持ち越さない） */
const clear = async (id: string) => {
  await post(session(id, 'codex-config/dismiss'), {})
  const queued = (await list()).queued[id]
  for (const item of queued?.items ?? []) await fetch(`${base}${session(id, `queue/${item.queue_id}`)}`, { method: 'DELETE', headers: { Origin: base } })
}

test('確かめが通れば今までどおり起こす', async () => {
  const res = await post(session('C1@r', 'reply?days=30'), { text: 'こんにちは' })
  assert.equal(res.status, 202)
  assert.deepEqual(calls, ['start:C1'])
})

test('返信: 起こさずに預かって止め、要対応に出す。「このまま起こす」で回る', async () => {
  ask = ASK
  const res = await post(session('C1@r', 'reply?days=30'), { text: 'こんにちは' })
  assert.equal(res.status, 202)
  const out = (await res.json()) as ReplyResponse
  assert.equal(out.via, 'queued')
  assert.equal(out.stuck, true)
  assert.deepEqual(calls, [], 'thread/resume の前で止める')
  const data = await list()
  assert.equal(data.codex_config_holds?.['C1@r']?.files[0], 'sub/.codex/config.toml')
  assert.equal(data.queued['C1@r']?.paused, CODEX_CONFIG_PAUSED)

  const pressed = await post(session('C1@r', 'codex-config/allow'), { fingerprint: 'fp1' })
  assert.equal(pressed.status, 200)
  assert.deepEqual(allowed, ['fp1'])
  assert.deepEqual(calls, ['start:C1'])
  const settled = await list()
  assert.equal(settled.codex_config_holds?.['C1@r'], undefined)
  assert.equal(settled.queued['C1@r'], undefined)
})

test('止まっている間に送った返信は後ろに並び、確かめを飛ばさない', async () => {
  ask = ASK
  await post(session('C1@r', 'reply?days=30'), { text: '1 通目' })
  const res = await post(session('C1@r', 'reply?days=30'), { text: '2 通目' })
  assert.equal(((await res.json()) as ReplyResponse).stuck, true)
  assert.deepEqual(calls, [])
  await clear('C1@r')
})

test('「続けて送る」では確かめを飛ばせない', async () => {
  ask = ASK
  await post(session('C1@r', 'reply?days=30'), { text: 'こんにちは' })
  await post(session('C1@r', 'queue/resume'), {})
  assert.deepEqual(calls, [])
  assert.equal((await list()).queued['C1@r']?.paused, CODEX_CONFIG_PAUSED)
  await clear('C1@r')
})

test('預かりが回るときに止めたら、同じ本文を増やさない', async () => {
  busy.add('C2@r')
  await post(session('C2@r', 'reply?days=30'), { text: 'こんにちは', queue: true })
  busy.delete('C2@r')
  ask = ASK
  const data = await list()
  assert.deepEqual(calls, [])
  assert.equal(data.queued['C2@r']?.items.length, 1)
  assert.equal(data.queued['C2@r']?.paused, CODEX_CONFIG_PAUSED)
  await post(session('C2@r', 'codex-config/allow'), { fingerprint: 'fp1' })
  assert.deepEqual(calls, ['start:C2'], '止めたときの待ち時間を残さず、押してすぐ回る')
})

test('見ていない指紋・変わった中身では通さない。別オリジンは断る', async () => {
  ask = ASK
  await post(session('C1@r', 'reply?days=30'), { text: 'こんにちは' })
  assert.equal((await post(session('C1@r', 'codex-config/allow'), { fingerprint: 'other' })).status, 409)
  assert.deepEqual(allowed, [], '画面が見ていたものと違えば確かめにも渡さない')
  assert.equal((await post(session('C1@r', 'codex-config/allow'), { fingerprint: 'fp1' }, 'http://evil.example')).status, 403)
  allowAnswer = { ...ASK, fingerprint: 'fp2' }
  assert.equal((await post(session('C1@r', 'codex-config/allow'), { fingerprint: 'fp1' })).status, 409)
  assert.equal((await list()).codex_config_holds?.['C1@r']?.fingerprint, 'fp2', '変わったものを出し直す')
  assert.deepEqual(calls, [])
  await clear('C1@r')
})

test('再起動: 行はメモリだけだが、止めた預かりをもう一度確かめて要対応に出し直す', async () => {
  ask = ASK
  await post(session('C1@r', 'reply?days=30'), { text: 'こんにちは' })
  const app = createApp(
    new FeedStore(dir),
    join(dir, 'dist'),
    { running: () => false, snapshot: () => ({}), async start() {} },
    new Approvals(),
    new BuildFreshness(join(dir, 'dist'), [], 0),
    undefined,
    new Authenticator(async () => null),
    { tmux: { run: async () => '' }, ps: async () => '', alive: () => false, codexAppServer: async () => false, codexWriterActive: async () => false, codexApp, codexConfig: gate },
    undefined,
    git,
  )
  const other = createServer((req, res) => void app(req, res))
  await new Promise<void>((resolve) => other.listen(0, '127.0.0.1', resolve))
  const addr = other.address()
  try {
    const data = (await (await fetch(`http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}/api/sessions?days=30`)).json()) as SessionsResponse
    assert.equal(data.codex_config_holds?.['C1@r']?.fingerprint, 'fp1')
    assert.equal(data.queued['C1@r']?.paused, CODEX_CONFIG_PAUSED)
    assert.deepEqual(calls, [])
  } finally {
    await new Promise<void>((resolve) => other.close(() => resolve()))
  }
  await clear('C1@r')
})

test('片付けても起こさない。止まっていないセッションへの答えは 404', async () => {
  ask = ASK
  await post(session('C1@r', 'reply?days=30'), { text: 'こんにちは' })
  assert.equal((await post(session('C1@r', 'codex-config/dismiss'), {})).status, 200)
  assert.deepEqual(calls, [])
  assert.equal((await list()).codex_config_holds?.['C1@r'], undefined)
  assert.equal((await post(session('A1@r', 'codex-config/allow'), { fingerprint: 'fp1' })).status, 404)
  await clear('C1@r')
})

test('新しいセッション・分岐・レビュー: 断って、要対応に出す（thread/start・thread/fork・thread/resume を投げない）', async () => {
  ask = ASK
  assert.equal((await post('/api/sessions/new?days=30', { text: 'はじめて', from: 'C1@r', agent: 'codex' })).status, 409)
  assert.equal((await post(session('C1@r', 'fork?days=30'), { text: '分岐' })).status, 409)
  assert.equal((await post(session('C1@r', 'review?days=30'), { target: 'uncommittedChanges' })).status, 409)
  assert.deepEqual(calls, [])
  assert.ok((await list()).codex_config_holds?.['C1@r'])
  // 押したあとは起こせる
  await post(session('C1@r', 'codex-config/allow'), { fingerprint: 'fp1' })
  assert.equal((await post('/api/sessions/new?days=30', { text: 'はじめて', from: 'C1@r', agent: 'codex' })).status, 202)
  assert.deepEqual(calls, ['startThread', 'start:N1'])
})

test('要約してから送る: 要約も起こさず、本文は入力欄に戻す', async () => {
  ask = ASK
  const res = await post(session('C1@r', 'reply?days=30'), { text: 'こんにちは', compact: true })
  assert.equal(res.status, 409)
  assert.deepEqual(calls, [])
  assert.equal((await list()).queued['C1@r'], undefined)
  await clear('C1@r')
})

test('SAI_CODEX_APP_SERVER=0（exec resume）の道でも、別プロセスを起こさない', async () => {
  const saved = process.env.SAI_CODEX_APP_SERVER
  process.env.SAI_CODEX_APP_SERVER = '0'
  const started: string[] = []
  const app = createApp(
    new FeedStore(dir),
    join(dir, 'dist'),
    {
      running: () => false,
      snapshot: () => ({}),
      async start(_id, cmd) {
        started.push(cmd.bin)
      },
    },
    new Approvals(),
    new BuildFreshness(join(dir, 'dist'), [], 0),
    undefined,
    new Authenticator(async () => null),
    { tmux: { run: async () => '' }, ps: async () => '', alive: () => false, codexAppServer: async () => false, codexWriterActive: async () => false, codexApp, codexConfig: gate },
    undefined,
    git,
  )
  const other = createServer((req, res) => void app(req, res))
  await new Promise<void>((resolve) => other.listen(0, '127.0.0.1', resolve))
  const addr = other.address()
  const url = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`
  try {
    const send = () => fetch(`${url}${session('C2@r', 'reply?days=30')}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: url }, body: JSON.stringify({ text: 'こんにちは' }) })
    ask = ASK
    assert.equal(((await (await send()).json()) as ReplyResponse).stuck, true)
    assert.deepEqual(started, [])
    await fetch(`${url}${session('C2@r', 'queue/resume')}`, { method: 'POST', headers: { Origin: url } })
    assert.deepEqual(started, [], '止めたままなら回らない')
    ask = null
    await fetch(`${url}${session('C2@r', 'queue/resume')}`, { method: 'POST', headers: { Origin: url } })
    assert.deepEqual(started, ['codex'], '通るようになれば今までの exec resume')
  } finally {
    await new Promise<void>((resolve) => other.close(() => resolve()))
    if (saved === undefined) delete process.env.SAI_CODEX_APP_SERVER
    else process.env.SAI_CODEX_APP_SERVER = saved
    await rm(join(dir, 'reply-queue.json'), { force: true })
  }
})

test('Claude のセッションと、端末で開いている Codex には効かない', async () => {
  ask = ASK
  assert.equal((await post(session('A1@r', 'reply?days=30'), { text: 'こんにちは' })).status, 202)
  assert.deepEqual(spawned, ['claude'])
  assert.equal((await list()).codex_config_holds?.['A1@r'], undefined)
  const typed = await post(session('T1@r', 'reply?days=30'), { text: 'こんにちは' })
  assert.notEqual(((await typed.json()) as ReplyResponse).via, 'queued')
  assert.equal((await list()).codex_config_holds?.['T1@r'], undefined)
  assert.deepEqual(calls, [])
})

test('止めたことを reply.log に残す（ファイルの名前は残さない）', async () => {
  ask = ASK
  await post(session('C1@r', 'reply?days=30'), { text: 'こんにちは' })
  const log = await readFile(join(dir, 'reply.log'), 'utf8')
  assert.match(log, /起こさずに止めた/)
  assert.ok(!log.includes('config.toml'))
  await clear('C1@r')
})

test('差分: サブディレクトリの .codex/ の印。git が読めなくても差分は落とさず「読めない」と返す', async () => {
  const diff = async () => (await (await fetch(`${base}${session('C1@r', 'diff?days=30')}`)).json()) as SessionDiffResponse
  const summary = async () => (await (await fetch(`${base}${session('C1@r', 'diff?days=30&summary=1')}`)).json()) as SessionDiffSummaryResponse
  assert.equal((await diff()).codex_config, undefined)
  assert.equal((await summary()).codex_config, undefined)
  codexIgnored = 'sub/.codex/config.toml\0'
  assert.deepEqual((await diff()).codex_config, [{ path: 'sub/.codex/config.toml', state: 'ignored' }])
  assert.equal((await summary()).codex_config, 1, '差分が無くてもボタンを出す数')
  codexIgnored = ''
})

test('本物の確かめを組むのは main.ts', async () => {
  const main = await readFile(new URL('./main.ts', import.meta.url), 'utf8')
  assert.match(main, /codexConfig: new CodexConfigGuard\(new RealGit\(\), feedDir\)/)
})
