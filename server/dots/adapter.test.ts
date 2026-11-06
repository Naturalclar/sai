// 受信箱のアダプター（#873）を偽の ChatGPT を相手に確かめる。本物の OpenAI・本物の dot には繋がない
// （送る口と名前を引く口を偽物に差し替える）。受信箱は一時ディレクトリの作り物の会話だけ
import { afterEach, beforeEach, test } from 'node:test'
import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { createServer } from 'node:http'
import type { Server } from 'node:http'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createDotsAdapter, ERROR_CALLBACK, MAX_ATTEMPTS, MAX_EVENTS_PER_CONVERSATION_PER_DAY, REPLY_DEADLINE_MS, RETRY_BASE_MS, SECRET_GRACE_MS, SUBSCRIPTION_TTL_MS } from './adapter.ts'
import { AdapterState, DOTS_ADAPTER_FILE } from './adapterState.ts'
import { DOTS_INBOX_FILE, DotsInbox } from './inbox.ts'
import { secretBytes, WEBHOOK_MAX_BYTES } from './webhook.ts'
import type { Sent, Target } from './webhook.ts'
import type { DotsConversation } from '../../shared/dots.ts'

const KEY_A = `whsec_${Buffer.from('k'.repeat(24)).toString('base64')}`
const KEY_B = `whsec_${Buffer.from('n'.repeat(24)).toString('base64')}`
const HOOK = 'https://hooks.chatgpt.example/events'
const TOKEN = 'fake-token'

interface Got {
  url: string
  address: string
  headers: Record<string, string>
  body: string
}

/** 偽の ChatGPT。届いたものを溜め、challenge には同じ値を返し、配信には `reply` が決めた状態を返す */
class FakeChatGpt {
  got: Got[] = []
  /** 配信（challenge 以外）への答え。throw すると届かなかった扱い */
  reply: (n: number) => number = () => 200
  challenge: 'echo' | 'wrong' | 500 = 'echo'
  private n = 0
  transport = async (t: Target, headers: Record<string, string>, body: string): Promise<Sent> => {
    this.got.push({ url: t.url.href, address: t.address, headers, body })
    const parsed = JSON.parse(body) as { type?: string; challenge?: string }
    if (parsed.type === 'verification') {
      if (this.challenge === 500) return { status: 500, body: '' }
      return { status: 200, body: JSON.stringify({ challenge: this.challenge === 'echo' ? parsed.challenge : 'x' }) }
    }
    const status = this.reply(this.n++)
    if (status < 0) throw new Error('timeout')
    return { status, body: '' }
  }
  events() {
    return this.got.filter((g) => !g.body.includes('"verification"'))
  }
}

/** 受け手の側で署名を確かめる（Standard Webhooks。並んだ署名のどれかが合えばよい） */
function verify(g: Got, key: string): boolean {
  const want = createHmac('sha256', secretBytes(key)!).update(`${g.headers['webhook-id']}.${g.headers['webhook-timestamp']}.${g.body}`).digest('base64')
  return (g.headers['webhook-signature'] ?? '').split(' ').includes(`v1,${want}`)
}

let dir: string
let clock: number
let chatgpt: FakeChatGpt
let revoked: Set<string>
let server: Server
let base: string
let adapter: ReturnType<typeof createDotsAdapter>
let inbox: DotsInbox

const lookup = async (host: string) => (host === 'hooks.chatgpt.example' ? ['8.8.8.8'] : host === 'inside.example' ? ['10.1.2.3'] : Promise.reject(new Error('NXDOMAIN')))

const make = () =>
  createDotsAdapter({
    feedDir: dir,
    verifyToken: async (t) => (t === TOKEN ? { subject: 'user-a' } : t === 'other-token' ? { subject: 'user-b' } : null),
    isActive: async (s) => !revoked.has(s),
    transport: chatgpt.transport,
    lookup,
    resource: 'https://inbox.example/mcp',
    authorizationServers: ['https://auth.example'],
    now: () => clock,
  })

const listen = async () => {
  server = createServer((req, res) => void adapter.handle(req, res))
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const addr = server.address()
  base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`
}

let rpcId = 0
const rpc = async (method: string, params: object = {}, token = TOKEN) => {
  const res = await fetch(`${base}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }) })
  return (await res.json()) as { result?: Record<string, unknown>; error?: { code: number; message: string } }
}
const call = async (name: string, args: object, token = TOKEN) => {
  const r = await rpc('tools/call', { name, arguments: args }, token)
  const result = r.result as { content: { text: string }[]; isError?: boolean }
  return { text: result.content[0]!.text, isError: result.isError === true }
}
const subscribe = (conversation_id: string, secret = KEY_A, url = HOOK, token = TOKEN) => rpc('events/subscribe', { name: 'message.created', arguments: { conversation_id }, delivery: { mode: 'webhook', url, secret } }, token)
const conv = async (id: string): Promise<DotsConversation> => (await inbox.conversations()).find((c) => c.id === id)!
const advance = (msDelta: number) => {
  clock += msDelta
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'sai-dots-adapter-'))
  clock = Date.parse('2026-11-06T00:00:00Z')
  chatgpt = new FakeChatGpt()
  revoked = new Set()
  inbox = new DotsInbox(join(dir, DOTS_INBOX_FILE), { now: () => new Date(clock) })
  adapter = make()
  await listen()
})

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
  await rm(dir, { recursive: true, force: true })
})

/** 会話を 1 つ始めて購読し、その後の投稿を返す */
const started = async (text = '予定を並べて') => {
  const first = await inbox.post('最初の投稿（購読より前）')
  const r = await subscribe(first.conversation_id)
  assert.ok(r.result, JSON.stringify(r.error))
  advance(1000)
  const m = await inbox.post(text, first.conversation_id)
  return { first, m, sub: r.result.id as string }
}

test('口: トークンが無ければ 401（保護されたリソースの印を指す）、Origin 付きは 403、ツールは 2 つ、イベントは 1 種類', async () => {
  const no = await fetch(`${base}/mcp`, { method: 'POST', body: '{}' })
  assert.equal(no.status, 401)
  assert.match(no.headers.get('www-authenticate') ?? '', /resource_metadata="https:\/\/inbox\.example\/\.well-known\/oauth-protected-resource"/)
  assert.equal((await fetch(`${base}/mcp`, { method: 'POST', headers: { authorization: 'Bearer wrong' }, body: '{}' })).status, 401)
  assert.equal((await fetch(`${base}/mcp`, { method: 'POST', headers: { authorization: `Bearer ${TOKEN}`, origin: 'https://evil.example' }, body: '{}' })).status, 403)
  const meta = (await (await fetch(`${base}/.well-known/oauth-protected-resource`)).json()) as { authorization_servers: string[] }
  assert.deepEqual(meta.authorization_servers, ['https://auth.example'])

  const init = await rpc('initialize', { protocolVersion: '2025-06-18' })
  assert.deepEqual((init.result as { capabilities: object }).capabilities, { tools: {}, events: {} })
  const tools = (await rpc('tools/list')).result as { tools: { name: string }[] }
  assert.deepEqual(tools.tools.map((t) => t.name), ['inbox_read', 'inbox_reply'])
  const events = (await rpc('events/list')).result as { events: { name: string }[] }
  assert.deepEqual(events.events.map((e) => e.name), ['message.created'])
  assert.equal((await rpc('sessions/list')).error?.code, -32601)
})

test('購読: challenge を通し、同じ購読は何度作っても同じ id。購読より前の投稿は配らない', async () => {
  const first = await inbox.post('前の投稿')
  const a = await subscribe(first.conversation_id)
  const b = await subscribe(first.conversation_id)
  assert.equal(a.result?.id, b.result?.id)
  assert.equal(adapter.state.subscriptions().length, 1)
  assert.equal(chatgpt.got.filter((g) => g.body.includes('"verification"')).length, 2)
  assert.ok(chatgpt.got.every((g) => verify(g, KEY_A)))
  // 覚えは持ち主だけが読める
  assert.equal((await stat(join(dir, DOTS_ADAPTER_FILE))).mode & 0o077, 0)
  await adapter.tick()
  assert.equal(chatgpt.events().length, 0)
  // 知らない会話・知らないイベント・形の違う鍵は断る
  assert.equal((await subscribe('no-such')).error?.code, -32602)
  assert.equal((await rpc('events/subscribe', { name: 'session.created', arguments: { conversation_id: first.conversation_id }, delivery: { mode: 'webhook', url: HOOK, secret: KEY_A } })).error?.code, -32602)
  assert.equal((await subscribe(first.conversation_id, 'plain-secret')).error?.code, -32602)
})

test('購読: challenge に失敗したら -32015 で、購読は残さない', async () => {
  const first = await inbox.post('前の投稿')
  for (const mode of ['wrong', 500] as const) {
    chatgpt.challenge = mode
    const r = await subscribe(first.conversation_id)
    assert.equal(r.error?.code, ERROR_CALLBACK, String(mode))
  }
  assert.equal(adapter.state.subscriptions().length, 0)
})

test('購読: private を指す・https でない callback は -32015 で、何も送らない', async () => {
  const first = await inbox.post('前の投稿')
  for (const url of ['https://inside.example/hook', 'https://127.0.0.1/hook', 'https://[::ffff:7f00:1]/hook', 'http://hooks.chatgpt.example/events']) {
    assert.equal((await subscribe(first.conversation_id, KEY_A, url)).error?.code, ERROR_CALLBACK, url)
  }
  assert.equal(chatgpt.got.length, 0)
})

test('配信: 署名付きで届け、2xx で受付済み。eventId は投稿の id', async () => {
  const { m } = await started()
  await adapter.tick()
  const [e] = chatgpt.events()
  assert.ok(e)
  assert.equal(e.address, '8.8.8.8')
  assert.ok(verify(e, KEY_A))
  const body = JSON.parse(e.body) as { eventId: string; name: string; data: { request_id: string; text: string } }
  assert.equal(body.eventId, m.id)
  assert.equal(e.headers['webhook-id'], m.id)
  assert.equal(body.name, 'message.created')
  assert.equal(body.data.request_id, m.request_id)
  assert.equal(body.data.text, '予定を並べて')
  assert.equal((await conv(m.conversation_id)).requests[1]?.state, 'accepted')
  // 2 周目は送り直さない
  await adapter.tick()
  assert.equal(chatgpt.events().length, 1)
})

test('読むと返答待ち、返すと完了。返答からはイベントを作らない（往復しない）', async () => {
  const { m } = await started()
  await adapter.tick()
  const read = JSON.parse((await call('inbox_read', { conversation_id: m.conversation_id })).text) as { messages: { id: string; state?: string }[] }
  assert.equal(read.messages.find((x) => x.id === m.id)?.state, 'awaiting')
  const r = await call('inbox_reply', { request_id: m.request_id, text: '並べました' })
  assert.equal(r.isError, false)
  assert.equal((await conv(m.conversation_id)).requests[1]?.state, 'done')
  advance(60_000)
  await adapter.tick()
  assert.equal(chatgpt.events().length, 1, '返答のぶんは配らない')
})

test('同じ依頼への返答: 同じ中身の 2 回目は同じ結果、違う中身は断る。受信箱には 1 件だけ', async () => {
  const { m } = await started()
  const a = JSON.parse((await call('inbox_reply', { request_id: m.request_id, text: '返答' })).text) as { message_id: string }
  const b = JSON.parse((await call('inbox_reply', { request_id: m.request_id, text: '返答' })).text) as { message_id: string; duplicate: boolean }
  assert.equal(b.message_id, a.message_id)
  assert.equal(b.duplicate, true)
  assert.equal((await call('inbox_reply', { request_id: m.request_id, text: '別の返答' })).isError, true)
  // 同時に 2 本来ても 1 件
  await Promise.all([call('inbox_reply', { request_id: m.request_id, text: '返答' }), call('inbox_reply', { request_id: m.request_id, text: '返答' })])
  assert.equal((await conv(m.conversation_id)).requests[1]?.replies.length, 1)
  assert.equal((await call('inbox_reply', { request_id: 'nope', text: 'x' })).isError, true)
})

test('同じ eventId が 2 回届いても・返答の順番が入れ替わっても、正しい依頼に 1 件ずつ付く', async () => {
  const { m } = await started('1 つ目')
  const m2 = await inbox.post('2 つ目', m.conversation_id)
  await adapter.tick()
  // 2 つ目への返答が先
  await call('inbox_reply', { request_id: m2.request_id, text: '2 つ目への返答' })
  await call('inbox_reply', { request_id: m.request_id, text: '1 つ目への返答' })
  await call('inbox_reply', { request_id: m2.request_id, text: '2 つ目への返答' })
  const c = await conv(m.conversation_id)
  assert.deepEqual(c.requests.slice(1).map((r) => [r.message.text, r.replies.map((x) => x.text), r.state]), [
    ['1 つ目', ['1 つ目への返答'], 'done'],
    ['2 つ目', ['2 つ目への返答'], 'done'],
  ])
})

test('見切り・5xx は同じ eventId で送り直す（時刻と署名は作り直す）。間をあけてから', async () => {
  const { m } = await started()
  chatgpt.reply = (n) => (n === 0 ? -1 : n === 1 ? 503 : 200)
  await adapter.tick()
  await adapter.tick()
  assert.equal(chatgpt.events().length, 1, '間をあける前には送り直さない')
  advance(RETRY_BASE_MS)
  await adapter.tick()
  advance(RETRY_BASE_MS * 2)
  await adapter.tick()
  const ev = chatgpt.events()
  assert.equal(ev.length, 3)
  assert.deepEqual(new Set(ev.map((e) => e.headers['webhook-id'])), new Set([m.id]))
  assert.equal(new Set(ev.map((e) => e.headers['webhook-timestamp'])).size, 3)
  assert.equal(new Set(ev.map((e) => e.headers['webhook-signature'])).size, 3)
  assert.equal((await conv(m.conversation_id)).requests[1]?.state, 'accepted')
})

test('回数の上限まで届かなければ失敗', async () => {
  const { m } = await started()
  chatgpt.reply = () => 500
  for (let i = 0; i < MAX_ATTEMPTS + 2; i++) {
    await adapter.tick()
    advance(RETRY_BASE_MS * 2 ** i)
  }
  assert.equal(chatgpt.events().length, MAX_ATTEMPTS)
  const r = (await conv(m.conversation_id)).requests[1]
  assert.equal(r?.state, 'failed')
  assert.match(r?.reason ?? '', /届けられません/)
})

test('410 は再送せず購読を消す。413 は再送しない', async () => {
  const { m, sub } = await started()
  chatgpt.reply = () => 413
  await adapter.tick()
  advance(RETRY_BASE_MS * 10)
  await adapter.tick()
  assert.equal(chatgpt.events().length, 1)
  assert.equal((await conv(m.conversation_id)).requests[1]?.state, 'failed')
  assert.ok(adapter.state.subscription(sub))

  chatgpt.reply = () => 410
  const m2 = await inbox.post('次', m.conversation_id)
  await adapter.tick()
  advance(RETRY_BASE_MS * 10)
  await adapter.tick()
  assert.equal(chatgpt.events().length, 2)
  assert.equal(adapter.state.subscription(sub), undefined)
  assert.equal((await conv(m.conversation_id)).requests.find((r) => r.message.id === m2.id)?.state, 'failed')
})

test('解除は 2 回しても同じ結果。ほかの持ち主の購読は消さない。解除したら配らず、配るはずだった依頼は失敗にする', async () => {
  const { m, sub } = await started()
  assert.deepEqual((await rpc('events/unsubscribe', { id: sub }, 'other-token')).result, {})
  assert.ok(adapter.state.subscription(sub))
  assert.deepEqual((await rpc('events/unsubscribe', { id: sub })).result, {})
  assert.deepEqual((await rpc('events/unsubscribe', { id: sub })).result, {})
  await adapter.tick()
  assert.equal(chatgpt.events().length, 0)
  assert.equal((await conv(m.conversation_id)).requests[1]?.state, 'failed')
  assert.equal((await conv(m.conversation_id)).requests[0]?.state, 'queued', '購読より前の投稿は触らない')
})

test('期限切れ・失効した購読には配らずに消す', async () => {
  const { sub } = await started()
  advance(SUBSCRIPTION_TTL_MS)
  await adapter.tick()
  assert.equal(chatgpt.events().length, 0)
  assert.equal(adapter.state.subscription(sub), undefined)

  const again = await started()
  revoked.add('user-a')
  await adapter.tick()
  assert.equal(chatgpt.events().length, 0)
  assert.equal(adapter.state.subscription(again.sub), undefined)
})

test('立て直したあとも購読と再送の途中が戻る', async () => {
  const { m } = await started()
  chatgpt.reply = (n) => (n === 0 ? 503 : 200)
  await adapter.tick()
  assert.equal(chatgpt.events().length, 1)
  // 別のアダプター（立て直した）で続ける
  await new Promise<void>((resolve) => server.close(() => resolve()))
  adapter = make()
  await listen()
  advance(RETRY_BASE_MS)
  await adapter.tick()
  assert.equal(chatgpt.events().length, 2)
  assert.equal((await conv(m.conversation_id)).requests[1]?.state, 'accepted')
})

test('鍵を替える途中は、前の鍵と今の鍵の 2 つで署名する。猶予を過ぎたら今の鍵だけ', async () => {
  const first = await inbox.post('前の投稿')
  await subscribe(first.conversation_id, KEY_A)
  await subscribe(first.conversation_id, KEY_B)
  advance(1000)
  await inbox.post('鍵を替えたあと', first.conversation_id)
  await adapter.tick()
  const e = chatgpt.events().at(-1)!
  assert.equal(e.headers['webhook-signature']?.split(' ').length, 2)
  assert.ok(verify(e, KEY_A) && verify(e, KEY_B))

  advance(SECRET_GRACE_MS + 1000)
  await subscribe(first.conversation_id, KEY_B)
  await inbox.post('猶予のあと', first.conversation_id)
  await adapter.tick()
  const late = chatgpt.events().at(-1)!
  assert.ok(verify(late, KEY_B))
  assert.equal(verify(late, KEY_A), false)
})

test('256 KiB を超える本文は切り詰めて送り、全文は inbox_read で読める', async () => {
  const { m } = await started('あ'.repeat(100_000))
  await adapter.tick()
  const e = chatgpt.events()[0]!
  assert.ok(Buffer.byteLength(e.body) <= WEBHOOK_MAX_BYTES)
  const body = JSON.parse(e.body) as { data: { text: string; truncated?: boolean } }
  assert.equal(body.data.truncated, true)
  assert.ok(body.data.text.length < 100_000)
  const read = JSON.parse((await call('inbox_read', { conversation_id: m.conversation_id })).text) as { messages: { id: string; text: string }[] }
  assert.equal(read.messages.find((x) => x.id === m.id)?.text.length, 100_000)
})

test('受け取られてから返答が無いまま期限を過ぎたら結果不明。そのあと返答が来れば完了', async () => {
  const { m } = await started()
  await adapter.tick()
  advance(REPLY_DEADLINE_MS + 1000)
  await adapter.tick()
  assert.equal((await conv(m.conversation_id)).requests[1]?.state, 'unknown')
  await call('inbox_reply', { request_id: m.request_id, text: '遅れた返答' })
  assert.equal((await conv(m.conversation_id)).requests[1]?.state, 'done')
})

test('1 つの会話で 1 日に配る数には上限がある', async () => {
  const { m } = await started()
  for (let i = 0; i < MAX_EVENTS_PER_CONVERSATION_PER_DAY; i++) await inbox.post(`追加 ${i}`, m.conversation_id)
  await adapter.tick()
  assert.equal(chatgpt.events().length, MAX_EVENTS_PER_CONVERSATION_PER_DAY)
  const failed = (await conv(m.conversation_id)).requests.filter((r) => r.state === 'failed')
  assert.equal(failed.length, 1)
  assert.match(failed[0]?.reason ?? '', /1 日/)
})

test('410 で購読を消したら、同じ周の残りの投稿へは送らず、止まったままの配信も残さない', async () => {
  const { m } = await started('1 つ目')
  await inbox.post('2 つ目', m.conversation_id)
  await inbox.post('3 つ目', m.conversation_id)
  chatgpt.reply = () => 410
  await adapter.tick()
  assert.equal(chatgpt.events().length, 1)
  assert.equal(adapter.state.allDeliveries().filter((d) => d.status === 'pending').length, 0)
  // 配れなくなった残りの依頼も、未配信のまま止めずに失敗にする（購読し直しても before に入って配られないので）
  assert.deepEqual((await conv(m.conversation_id)).requests.slice(1).map((r) => r.state), ['failed', 'failed', 'failed'])
})

test('再送の途中で購読の期限が切れたら、その依頼は失敗にする', async () => {
  const { m } = await started()
  chatgpt.reply = () => 503
  await adapter.tick()
  advance(SUBSCRIPTION_TTL_MS)
  await adapter.tick()
  const r = (await conv(m.conversation_id)).requests[1]
  assert.equal(r?.state, 'failed')
  assert.match(r?.reason ?? '', /期限/)
})

test('配信のときに名前が一度引けなくても、送り直す側に入れて次で届ける', async () => {
  const { m } = await started()
  let fail = true
  // 名前を引く口だけ差し替えたアダプター（1 回目だけ引けない）
  adapter = createDotsAdapter({ feedDir: dir, verifyToken: async () => ({ subject: 'user-a' }), isActive: async () => true, transport: chatgpt.transport, lookup: async (h) => (fail ? ((fail = false), Promise.reject(new Error('SERVFAIL'))) : lookup(h)), resource: 'https://inbox.example/mcp', authorizationServers: [], now: () => clock })
  await adapter.tick()
  assert.equal(chatgpt.events().length, 0)
  assert.equal((await conv(m.conversation_id)).requests[1]?.state, 'queued')
  advance(RETRY_BASE_MS)
  await adapter.tick()
  assert.equal(chatgpt.events().length, 1)
  assert.equal((await conv(m.conversation_id)).requests[1]?.state, 'accepted')
})

test('30 日たっても、返答の無い依頼を配り直さない', async () => {
  const { first, m } = await started()
  await adapter.tick()
  advance(REPLY_DEADLINE_MS + 1000)
  await adapter.tick()
  assert.equal((await conv(m.conversation_id)).requests[1]?.state, 'unknown')
  advance(31 * 24 * 60 * 60_000)
  // ChatGPT が呼び直し続けている購読
  await subscribe(first.conversation_id)
  await adapter.tick()
  await adapter.tick()
  assert.equal(chatgpt.events().length, 1)
  assert.equal((await conv(m.conversation_id)).requests[1]?.state, 'unknown')
})

test('立ち上げ直後に読み込みと書き込みが重なっても、書いたものを古い中身で被せない', async () => {
  const { sub } = await started()
  const st = new AdapterState(join(dir, DOTS_ADAPTER_FILE))
  const reading = st.load()
  await st.load()
  const s = st.subscription(sub)!
  await st.putSubscription({ ...s, expires_at: '2099-01-01T00:00:00.000Z' })
  await reading
  assert.equal(st.subscription(sub)?.expires_at, '2099-01-01T00:00:00.000Z')
})

test('同じ会話に別の購読があっても、その購読が配らない依頼は、購読を消すときに失敗にする', async () => {
  const first = await inbox.post('前の投稿')
  await subscribe(first.conversation_id, KEY_A, HOOK)
  advance(1000)
  await inbox.post('R1', first.conversation_id)
  await inbox.post('R2', first.conversation_id)
  // あとから別の送り先で購読（R1・R2 は before に入る）
  await subscribe(first.conversation_id, KEY_A, 'https://hooks.chatgpt.example/other')
  advance(1000)
  await inbox.post('R3', first.conversation_id)
  chatgpt.reply = (n) => (n === 0 ? 410 : 503)
  await adapter.tick()
  const states = Object.fromEntries((await conv(first.conversation_id)).requests.map((r) => [r.message.text, r.state]))
  assert.equal(states.R1, 'failed')
  assert.equal(states.R2, 'failed', 'R2 はどの購読も配らない')
  assert.equal(states.R3, 'queued', 'R3 は残った購読が配る（送り直し中）')
})

test('1 つの購読が 410 を返しても、同じ投稿をほかの購読が配れるなら失敗にせず、そちらで届ける', async () => {
  const first = await inbox.post('前の投稿')
  await subscribe(first.conversation_id, KEY_A, HOOK)
  await subscribe(first.conversation_id, KEY_A, 'https://hooks.chatgpt.example/other')
  advance(1000)
  const m = await inbox.post('R3', first.conversation_id)
  chatgpt.reply = (n) => (n === 0 ? 410 : 200)
  await adapter.tick()
  assert.equal(chatgpt.events().length, 2)
  assert.equal((await conv(m.conversation_id)).requests.find((r) => r.message.id === m.id)?.state, 'accepted')
  // どちらも配れなければ失敗
  const m2 = await inbox.post('R4', first.conversation_id)
  chatgpt.reply = () => 413
  await adapter.tick()
  assert.equal((await conv(m.conversation_id)).requests.find((r) => r.message.id === m2.id)?.state, 'failed')
})

