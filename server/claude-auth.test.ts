// Claude のログイン切れを一覧の応答と返信の失敗に載せる（#685）。本物の createApp に偽の読み手を渡して、
// 載る・直ると消えて rev が変わる・分からなければ載らない・失敗 1 つにつき 1 回しか聞かない・Claude 以外の失敗では聞かない・
// 聞き直す口は同一オリジンだけ・既定では聞かない、を見る
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import type { Server } from 'node:http'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ClaudeAuthCheckResponse, FeedRow, ReplyingMap, SessionsResponse } from '../shared/types.ts'
import { createApp } from './app.ts'
import type { ClaudeAuthReader, ClaudeAuthState } from './local/claudeAuth.ts'
import { FeedStore } from './rows/store.ts'
import { localDate } from './rows/aggregate.ts'
import { row } from './rows/aggregate.test.ts'
import type { Runner } from './reply/runner.ts'

let replying: ReplyingMap = {}
const runner: Runner = { running: () => false, snapshot: (): ReplyingMap => replying, start: async () => {} }

/** 偽の読み手。`answer` を返し、聞かれた回数を数える */
class FakeAuth implements ClaudeAuthReader {
  answer: ClaudeAuthState | undefined
  asked = 0
  private last: ClaudeAuthState | undefined
  constructor(answer: ClaudeAuthState | undefined) {
    this.answer = answer
  }
  /** 答えるまでの待ち（ミリ秒）。答えが出るまで `peek()` は前のまま */
  delay = 0
  async check(): Promise<ClaudeAuthState | undefined> {
    this.asked++
    const answer = this.answer
    if (this.delay > 0) await new Promise((resolve) => setTimeout(resolve, this.delay))
    this.last = answer
    return this.last
  }
  peek(): ClaudeAuthState | undefined {
    return this.last
  }
}

let dir: string
const servers: Server[] = []
const saved: Record<string, string | undefined> = {}

async function start(rows: FeedRow[], auth?: ClaudeAuthReader): Promise<string> {
  const feedDir = await mkdtemp(join(dir, 'feed-'))
  await mkdir(feedDir, { recursive: true })
  await writeFile(join(feedDir, `${localDate(new Date().toISOString())}.jsonl`), rows.map((r) => JSON.stringify(r)).join('\n') + '\n')
  const app = createApp(new FeedStore(feedDir), join(dir, 'dist'), runner, undefined, undefined, undefined, undefined, {
    tmux: { run: async () => '' },
    ps: async () => '',
    ...(auth ? { claudeAuth: auth } : {}),
  })
  const server = createServer((req, res) => void app(req, res))
  servers.push(server)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const addr = server.address()
  return `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`
}

const sessions = async (base: string): Promise<SessionsResponse> => (await fetch(`${base}/api/sessions`)).json() as Promise<SessionsResponse>
const failed = (since: string, over: Record<string, unknown> = {}) => ({ since, text: '続けて', failed: { code: 1, tail: 'boom', ...over } })
const rows = () => [row(new Date(), 'S1', { repo: 'r', host: 'mac' }), row(new Date(), 'X1', { repo: 'r', agent: 'codex', host: 'mac' })]

before(async () => {
  for (const key of ['SAI_TERMINAL', 'SAI_CODEX_APP_SERVER', 'SAI_OPENCODE_SERVER', 'AGENT_FEED_HOST']) saved[key] = process.env[key]
  for (const key of ['SAI_TERMINAL', 'SAI_CODEX_APP_SERVER', 'SAI_OPENCODE_SERVER']) process.env[key] = '0'
  process.env.AGENT_FEED_HOST = 'mac'
  dir = await mkdtemp(join(tmpdir(), 'sai-claude-auth-'))
})

after(async () => {
  for (const server of servers) await new Promise<void>((resolve) => server.close(() => resolve()))
  await rm(dir, { recursive: true, force: true })
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
})

test('claude_logged_out: Claude の返信が失敗したら 1 回だけ聞き、切れていれば一覧と失敗の両方に載る。直ると消えて rev も変わる', async () => {
  const auth = new FakeAuth({ loggedIn: false, method: 'none' })
  const base = await start(rows(), auth)
  replying = {}
  try {
    const idle = await sessions(base)
    assert.equal(idle.claude_logged_out, false, '聞いていない間は言わない')
    assert.equal(auth.asked, 0, 'ポーリングでは聞かない')

    replying = { 'S1@r': failed('2026-10-05T01:00:00.000Z') }
    const out = await sessions(base)
    assert.equal(out.claude_logged_out, true)
    assert.equal(out.replying['S1@r']?.failed?.logged_out, true, '失敗が最初に見えた応答で印が付く（画面は失敗を 1 回しか読まない）')
    assert.equal(out.replying['S1@r']?.failed?.tail, 'boom', 'CLI の文言はそのまま')
    await sessions(base)
    await fetch(`${base}/api/sessions/${encodeURIComponent('S1@r')}`)
    assert.equal(auth.asked, 1, '同じ失敗では聞き直さない')

    // 同時に来た応答（一覧と詳細）は、後の方も答えを待ってから返す（待たないと、印の無い失敗を画面が先に読む）
    // 前に聞いた結果は「ログインしている」（起動時に聞いた形）。そこから切れた
    auth.answer = { loggedIn: true, method: 'claude.ai' }
    await auth.check()
    auth.answer = { loggedIn: false, method: 'none' }
    auth.delay = 50
    replying = { 'S1@r': failed('2026-10-05T01:30:00.000Z') }
    const both = await Promise.all([sessions(base), sessions(base)])
    assert.deepEqual(both.map((r) => r.replying['S1@r']?.failed?.logged_out), [true, true])
    assert.equal(auth.asked, 3)
    auth.delay = 0

    // Mac でログインし直して「確かめ直す」
    auth.answer = { loggedIn: true, method: 'claude.ai' }
    const cross = await fetch(`${base}/api/claude-auth/check`, { method: 'POST', headers: { Origin: 'http://evil.example', 'Content-Type': 'application/json' }, body: '{}' })
    assert.equal(cross.status, 403)
    assert.equal((await fetch(`${base}/api/claude-auth/check`)).status, 405)
    assert.equal(auth.asked, 3, '断った分では聞かない')
    const res = await fetch(`${base}/api/claude-auth/check`, { method: 'POST', headers: { Origin: base, 'Content-Type': 'application/json' }, body: '{}' })
    assert.deepEqual((await res.json()) as ClaudeAuthCheckResponse, { logged_in: true })
    const fixed = await sessions(base)
    assert.equal(fixed.claude_logged_out, false)
    assert.equal(fixed.replying['S1@r']?.failed?.logged_out, undefined)
    assert.notEqual(fixed.rev, out.rev, '次の行を待たずにバナーが消える')

    // 次の失敗（since が違う）ではもう一度聞く
    replying = { 'S1@r': failed('2026-10-05T02:00:00.000Z') }
    await sessions(base)
    assert.equal(auth.asked, 5)
  } finally {
    replying = {}
  }
})

test('claude_logged_out: Codex の失敗・届かなかった返信・ターンのエラーでは聞かない。行の無いセッションの失敗は聞く', async () => {
  const auth = new FakeAuth({ loggedIn: false, method: 'none' })
  const base = await start(rows(), auth)
  try {
    replying = {
      'X1@r': failed('2026-10-05T01:00:00.000Z'),
      'S1@r': { since: '2026-10-05T01:00:00.000Z', text: '続けて', failed: { tail: '届いていない' } },
    }
    let list = await sessions(base)
    assert.equal(auth.asked, 0)
    assert.equal(list.claude_logged_out, false)
    assert.equal(list.replying['X1@r']?.failed?.logged_out, undefined)
    replying = { 'S1@r': failed('2026-10-05T01:00:00.000Z', { turn_error: true }) }
    await sessions(base)
    assert.equal(auth.asked, 0)
    // 新しいセッション（行がまだ無い）は Claude かもしれない
    replying = { 'NEW@r': failed('2026-10-05T01:00:00.000Z') }
    list = await sessions(base)
    assert.equal(auth.asked, 1)
    assert.equal(list.replying['NEW@r']?.failed?.logged_out, true)
  } finally {
    replying = {}
  }
})

test('claude_logged_out: 分からない（undefined）なら載せない。既定（読み手を渡さない）では聞かない', async () => {
  const auth = new FakeAuth(undefined)
  const base = await start(rows(), auth)
  try {
    replying = { 'S1@r': failed('2026-10-05T01:00:00.000Z') }
    const list = await sessions(base)
    assert.equal(auth.asked, 1)
    assert.equal(list.claude_logged_out, false)
    assert.equal(list.replying['S1@r']?.failed?.logged_out, undefined)

    const plain = await start(rows())
    assert.equal((await sessions(plain)).claude_logged_out, false)
    const res = await fetch(`${plain}/api/claude-auth/check`, { method: 'POST', headers: { Origin: plain, 'Content-Type': 'application/json' }, body: '{}' })
    assert.deepEqual((await res.json()) as ClaudeAuthCheckResponse, { logged_in: null })
  } finally {
    replying = {}
  }
})
