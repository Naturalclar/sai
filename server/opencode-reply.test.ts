// #382。OpenCode への返信が `opencode run -s`（ワンショット）ではなく `opencode serve` の HTTP へ行くこと。
// 本物の `opencode` には触らず、`opencodeApp` を差し替えて経路だけを見る
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import type { Server } from 'node:http'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ReplyResponse, SessionDetailResponse, SessionSkillsResponse } from '../shared/types.ts'
import { createApp } from './app.ts'
import { Approvals } from './approvals/approvals.ts'
import { localDate } from './rows/aggregate.ts'
import { row } from './rows/aggregate.test.ts'
import { FeedStore } from './rows/store.ts'
import { BuildFreshness } from './local/buildFreshness.ts'
import { Authenticator } from './auth.ts'
import { TerminalReplies } from './reply/terminal.ts'
import type { ReplyCommand, Runner } from './reply/runner.ts'
import type { OpencodeApp, OpencodeTurnInput } from './reply/opencodeServer.ts'

let dir: string
let work: string
let server: Server
let base: string
const sent: OpencodeTurnInput[] = []
const skillCalls: string[] = []
const started: { id: string; cmd: ReplyCommand }[] = []
const runner: Runner = { running: () => false, snapshot: () => ({}), async start(id, cmd) { started.push({ id, cmd }) } }
/** 送ったぶんを覚え、`busy` で「処理中」を作れる偽の serve */
const opencodeApp: OpencodeApp = {
  busy: false,
  running(id: string) {
    return this.busy && id === 'ses_1@r'
  },
  replying: () => ({}),
  async start(input: OpencodeTurnInput) {
    if (input.session === 'ses_ng') throw new Error('opencode serve が 404 を返しました')
    sent.push(input)
  },
  settle: () => [],
  async skills(cwd: string) {
    skillCalls.push(cwd)
    return [
      { name: 'demo-skill', description: 'プロジェクトのスキル', source: 'user' as const },
      { name: 'init', description: 'guided AGENTS.md setup', source: 'command' as const },
    ]
  },
  stop: () => {},
} as OpencodeApp & { busy: boolean }

const saved = process.env.AGENT_FEED_HOST
const now = new Date()

const app = (): ReturnType<typeof createApp> =>
  createApp(
    new FeedStore(dir),
    join(dir, 'dist'),
    runner,
    new Approvals(),
    new BuildFreshness(join(dir, 'dist'), [], 0),
    undefined,
    new Authenticator(async () => null),
    { tmux: { run: async () => { throw new Error('no tmux') } }, ps: async () => '', replies: new TerminalReplies(), opencodeApp },
  )

const post = (path: string, body: unknown) =>
  fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', origin: base }, body: JSON.stringify(body) })

before(async () => {
  process.env.AGENT_FEED_HOST = 'testmac'
  dir = await mkdtemp(join(tmpdir(), 'sai-oc-'))
  work = await mkdtemp(join(tmpdir(), 'sai-oc-work-'))
  await writeFile(
    join(dir, `${localDate(now.toISOString())}.jsonl`),
    [
      JSON.stringify(row(new Date(now.getTime() - 60_000), 'ses_1', { agent: 'opencode', repo: 'r', cwd: work, host: 'testmac', model: 'ollama/qwen3:8b' })),
      JSON.stringify(row(new Date(now.getTime() - 30_000), 'ses_ng', { agent: 'opencode', repo: 'r', cwd: work, host: 'testmac' })),
    ].join('\n') + '\n',
  )
  const handler = app()
  server = createServer((req, res) => void handler(req, res))
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const addr = server.address()
  base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`
})

after(async () => {
  if (saved === undefined) delete process.env.AGENT_FEED_HOST
  else process.env.AGENT_FEED_HOST = saved
  await new Promise<void>((r) => server.close(() => r()))
  await rm(dir, { recursive: true, force: true })
  await rm(work, { recursive: true, force: true })
})

test('OpenCode の返信は serve へ送る（子プロセスは起こさない）', async () => {
  const res = await post('/api/sessions/ses_1%40r/reply', { text: 'テストして' })
  assert.equal(res.status, 202)
  const body = (await res.json()) as ReplyResponse
  assert.equal(body.via, 'app-server')
  assert.equal(body.session, 'ses_1')
  assert.deepEqual(sent.map((s) => ({ id: s.id, session: s.session, text: s.text })), [{ id: 'ses_1@r', session: 'ses_1', text: 'テストして' }])
  assert.equal(started.length, 0, '`opencode run -s` は起こさない')
})

test('送れなければ 500 で理由を出す（画面の「送信失敗」に出る）', async () => {
  const res = await post('/api/sessions/ses_ng%40r/reply', { text: 'だめな方' })
  assert.equal(res.status, 500)
  assert.match((await res.text()), /opencode serve/)
})

test('処理中なら預かる（#305 と同じ。二重にターンを走らせない）', async () => {
  ;(opencodeApp as OpencodeApp & { busy: boolean }).busy = true
  try {
    const queued = await post('/api/sessions/ses_1%40r/reply', { text: 'あとで', queue: true })
    assert.equal(queued.status, 202)
    assert.equal(((await queued.json()) as ReplyResponse).via, 'queued')
    const refused = await post('/api/sessions/ses_1%40r/reply', { text: '割り込み' })
    assert.equal(refused.status, 409, 'queue を付けなければ今までどおり 409')
    assert.equal(sent.length, 1, '処理中の間は送らない')
    const detail = (await (await fetch(`${base}/api/sessions/ses_1%40r`)).json()) as SessionDetailResponse
    assert.equal(detail.queued['ses_1@r']?.items[0]?.text, 'あとで', '預かりは画面の QueuedBubble に出る')
  } finally {
    ;(opencodeApp as OpencodeApp & { busy: boolean }).busy = false
  }
})

test('SAI_OPENCODE_SERVER=0 なら今までどおり `opencode run -s` に戻す', async () => {
  const before = process.env.SAI_OPENCODE_SERVER
  process.env.SAI_OPENCODE_SERVER = '0'
  const handler = app()
  const s2 = createServer((req, res) => void handler(req, res))
  await new Promise<void>((r) => s2.listen(0, '127.0.0.1', r))
  const addr = s2.address()
  const b2 = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`
  try {
    const res = await fetch(`${b2}/api/sessions/ses_1%40r/reply`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: b2 },
      body: JSON.stringify({ text: '旧経路' }),
    })
    assert.equal(res.status, 202)
    assert.equal(((await res.json()) as ReplyResponse).via, 'process')
    assert.deepEqual(started.at(-1)?.cmd.args.slice(0, 3), ['run', '-s', 'ses_1'])
  } finally {
    if (before === undefined) delete process.env.SAI_OPENCODE_SERVER
    else process.env.SAI_OPENCODE_SERVER = before
    await new Promise<void>((r) => s2.close(() => r()))
  }
})

test('`/` の候補は OpenCode の本体に聞く（#393。セッションの cwd を渡す）', async () => {
  const res = await fetch(`${base}/api/sessions/ses_1%40r/skills`)
  assert.equal(res.status, 200)
  const body = (await res.json()) as SessionSkillsResponse
  assert.deepEqual(body.skills.map((s) => `${s.source}:${s.name}`), ['user:demo-skill', 'command:init'])
  assert.deepEqual(skillCalls, [work], 'サーバの cwd ではなく、そのセッションの cwd で引く')
})
