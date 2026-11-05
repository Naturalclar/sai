// dots との会話ログの口（#872）。本物の createApp に一時の feed dir を渡して、受信箱に足して読めることを見る。
// 外には何も出さない（配信の口はまだ無い）。返答は作り物をテストから受信箱に書く
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import type { Server } from 'node:http'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createApp } from './app.ts'
import { Approvals } from './approvals/approvals.ts'
import { FeedStore } from './rows/store.ts'
import { BuildFreshness } from './local/buildFreshness.ts'
import { Authenticator } from './auth.ts'
import { DigestStore, Digester } from './digest/digest.ts'
import { DOTS_INBOX_FILE, DotsInbox } from './dots/inbox.ts'
import type { DotsPostResponse, DotsResponse } from '../shared/dots.ts'

let dir: string
let server: Server
let base: string

const post = (body: unknown, origin: string | null = base) =>
  fetch(`${base}/api/dots`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(origin ? { Origin: origin } : {}) }, body: JSON.stringify(body) })
const read = async () => (await (await fetch(`${base}/api/dots`)).json()) as DotsResponse

before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'sai-dots-'))
  const store = new DigestStore(join(dir, 'digest.jsonl'))
  const digester = new Digester(store, null, { enabled: false, model: '', persona: async () => 'ESFP' })
  const app = createApp(new FeedStore(dir), join(dir, 'dist'), { running: () => false, snapshot: () => ({}), async start() {} }, new Approvals(), new BuildFreshness(join(dir, 'dist'), [], 0), digester, new Authenticator(async () => null))
  server = createServer((req, res) => void app(req, res))
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const addr = server.address()
  base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`
})

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
  await rm(dir, { recursive: true, force: true })
})

test('受信箱が無ければ空の一覧', async () => {
  const body = await read()
  assert.deepEqual(body, { rev: 'none', conversations: [] })
})

test('会話を始めて投稿し、続けて同じ会話に投稿すると時系列で並び、状態は queued', async () => {
  const first = await post({ text: '  今日の予定を並べて  ' })
  assert.equal(first.status, 200)
  const m1 = ((await first.json()) as DotsPostResponse).message
  assert.equal(m1.text, '今日の予定を並べて')
  assert.equal(m1.source, 'sai-human')
  assert.ok(m1.request_id && m1.request_id !== m1.id)

  const second = await post({ text: '午後だけでいい', conversation_id: m1.conversation_id })
  assert.equal(second.status, 200)
  const m2 = ((await second.json()) as DotsPostResponse).message
  assert.equal(m2.conversation_id, m1.conversation_id)

  const body = await read()
  assert.notEqual(body.rev, 'none')
  const c = body.conversations.find((x) => x.id === m1.conversation_id)
  assert.deepEqual(c?.requests.map((r) => [r.message.text, r.state]), [['今日の予定を並べて', 'queued'], ['午後だけでいい', 'queued']])
  // 行の記録の置き場とは別のファイルで、持ち主だけが読める
  const s = await stat(join(dir, DOTS_INBOX_FILE))
  assert.equal(s.mode & 0o077, 0)
})

test('作り物の返答は、書いた順が入れ替わっても reply_to の依頼の下に並ぶ', async () => {
  const a = ((await (await post({ text: '依頼 A' })).json()) as DotsPostResponse).message
  const b = ((await (await post({ text: '依頼 B', conversation_id: a.conversation_id })).json()) as DotsPostResponse).message
  const inbox = new DotsInbox(join(dir, DOTS_INBOX_FILE))
  await inbox.reply(a.conversation_id, b.request_id!, 'B への返答')
  await inbox.reply(a.conversation_id, a.request_id!, 'A への返答')
  await inbox.setState(a.request_id!, 'accepted')
  await inbox.setState(a.request_id!, 'done')
  const c = (await read()).conversations.find((x) => x.id === a.conversation_id)
  assert.deepEqual(c?.requests.map((r) => [r.message.text, r.state, r.replies.map((m) => m.text)]), [
    ['依頼 A', 'done', ['A への返答']],
    ['依頼 B', 'queued', ['B への返答']],
  ])
})

test('別のオリジンからの書き込みは 403 で、受信箱には何も書かない', async () => {
  const was = await readFile(join(dir, DOTS_INBOX_FILE), 'utf-8')
  const res = await post({ text: '外から' }, 'http://evil.example')
  assert.equal(res.status, 403)
  assert.equal(await readFile(join(dir, DOTS_INBOX_FILE), 'utf-8'), was)
})

test('本文が空・長すぎる・会話の id の形が違う・無い会話は断る', async () => {
  assert.equal((await post({ text: '   ' })).status, 400)
  assert.equal((await post({ text: 'あ'.repeat(20001) })).status, 400)
  assert.equal((await post({ text: 'x', conversation_id: '../etc' })).status, 400)
  assert.equal((await post({ text: 'x', conversation_id: '00000000-0000-4000-8000-000000000000' })).status, 404)
  assert.equal((await post(['x'])).status, 400)
  assert.equal((await fetch(`${base}/api/dots`, { method: 'PUT', headers: { Origin: base }, body: '{}' })).status, 405)
})
