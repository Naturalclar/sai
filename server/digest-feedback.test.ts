// POST /api/digest/feedback（#346）。本物の createApp に偽の口の Digester を渡して、
// 一言が変だと言われたぶんが ~/.agent-feed/digest-feedback.jsonl に溜まることを見る
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import type { Server } from 'node:http'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createApp } from './app.ts'
import { Approvals } from './approvals/approvals.ts'
import { localDate } from './rows/aggregate.ts'
import { row } from './rows/aggregate.test.ts'
import { FeedStore } from './rows/store.ts'
import { BuildFreshness } from './local/buildFreshness.ts'
import { Authenticator } from './auth.ts'
import { DigestStore, Digester } from './digest/digest.ts'
import { FEEDBACK_FILE } from './digest/feedback.ts'
import type { DigestFeedbackEntry } from './digest/feedback.ts'
import { digestKey } from '../shared/digestFeedback.ts'
import type { DigestFeedbackResponse } from '../shared/digestFeedback.ts'

let dir: string
let server: Server
let base: string
let key: string
/** 案だけ作った行（一言は切っていて summary が空。#560） */
let askKey: string

const post = (body: unknown, origin = true) =>
  fetch(`${base}/api/digest/feedback`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(origin ? { Origin: base } : {}) },
    body: JSON.stringify(body),
  })

const lines = async (): Promise<DigestFeedbackEntry[]> => {
  const text = await readFile(join(dir, FEEDBACK_FILE), 'utf-8').catch(() => '')
  return text.split('\n').filter(Boolean).map((l) => JSON.parse(l) as DigestFeedbackEntry)
}

before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'sai-fb-app-'))
  const now = new Date()
  const r = row(now, 'S1', { repo: 'r', text: 'PR #284 を出しました。よければ「マージして」と言ってください。' })
  key = digestKey(r)
  const r2 = row(now, 'S2', { repo: 'r', text: 'テストが 2 本落ちています。直しますか？' })
  askKey = digestKey(r2)
  await writeFile(join(dir, `${localDate(now.toISOString())}.jsonl`), JSON.stringify(r) + '\n' + JSON.stringify(r2) + '\n')

  // 一言はすでに作ってあることにする（口は叩かない）
  const store = new DigestStore(join(dir, 'digest.jsonl'))
  await writeFile(store.path, JSON.stringify({ key, persona: 'ESFP', summary: 'PR #284 出したよ、マージして？', model: 'qwen3:8b', ts: now.toISOString() }) + '\n' + JSON.stringify({ key: askKey, persona: 'ESFP', summary: '', model: 'qwen3:8b', ts: now.toISOString(), next_ask: '直して' }) + '\n')
  await store.load()
  const digester = new Digester(store, null, { enabled: false, model: '', persona: async () => 'ESFP' })

  const app = createApp(
    new FeedStore(dir),
    join(dir, 'dist'),
    { running: () => false, snapshot: () => ({}), async start() {} },
    new Approvals(),
    new BuildFreshness(join(dir, 'dist'), [], 0),
    digester,
    new Authenticator(async () => null),
  )
  server = createServer((req, res) => void app(req, res))
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const addr = server.address()
  base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`
})

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
  await rm(dir, { recursive: true, force: true })
})

test('変だと言われたら、そのときの一言・口・性格と一緒に残す。一言は鍵から引く（画面の文字列は信じない）', async () => {
  const res = await post({ key, reason: 'meaning', note: '引用のまま残してほしい', summary: '嘘の一言' })
  assert.equal(res.status, 200)
  assert.deepEqual(await res.json(), { ok: true, count: 1 } satisfies DigestFeedbackResponse)
  const got = await lines()
  assert.equal(got.length, 1)
  assert.equal(got[0]!.key, key)
  assert.equal(got[0]!.summary, 'PR #284 出したよ、マージして？', 'body の summary ではなく digest.jsonl のもの')
  assert.equal(got[0]!.model, 'qwen3:8b')
  assert.equal(got[0]!.persona, 'ESFP')
  assert.equal(got[0]!.reason, 'meaning')
  assert.equal(got[0]!.note, '引用のまま残してほしい')
  assert.ok(got[0]!.ts)
})

test('理由が無い・知らない理由・鍵が無い・長すぎる note は 400。知らない鍵は 404', async () => {
  assert.equal((await post({ key })).status, 400)
  assert.equal((await post({ key, reason: 'なんとなく' })).status, 400)
  assert.equal((await post({ reason: 'meaning' })).status, 400)
  assert.equal((await post({ key, reason: 'meaning', note: 'あ'.repeat(201) })).status, 400)
  assert.equal((await post({ key: 'S9@r|2026-01-01T00:00:00+09:00', reason: 'meaning' })).status, 404)
  assert.equal((await lines()).length, 1, '弾いたものは残さない')
})

test('別オリジンは 403、GET は 405（画面から叩く口。返信と同じ）', async () => {
  const cross = await fetch(`${base}/api/digest/feedback`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: 'http://evil.example' },
    body: JSON.stringify({ key, reason: 'meaning' }),
  })
  assert.equal(cross.status, 403)
  assert.equal((await fetch(`${base}/api/digest/feedback`)).status, 405)
  assert.equal((await lines()).length, 1)
})

test('#359 で足した理由（why / next）も受け付ける', async () => {
  const res = await post({ key, reason: 'next', note: '通ったら何と言えばいいか書いてほしい' })
  assert.equal(res.status, 200)
  const got = await lines()
  assert.equal(got.at(-1)!.reason, 'next')
  assert.equal((await post({ key, reason: 'why' })).status, 200)
  assert.equal((await lines()).at(-1)!.reason, 'why')
})

test('note は省ける。2 件目も後ろに足される', async () => {
  const res = await post({ key, reason: 'long' })
  assert.equal(res.status, 200)
  assert.equal(((await res.json()) as DigestFeedbackResponse).count, 4)
  const got = await lines()
  assert.equal(got.length, 4)
  assert.equal(got.at(-1)!.note, undefined)
  assert.equal(got.at(-1)!.reason, 'long')
})

test('使われたかの合図（#446）: 詳細を開いた・案を受け取った、も同じファイルに溜める。「変？」の件数には数えない', async () => {
  const before = (await lines()).length
  const complaints = ((await (await post({ key, reason: 'other' })).json()) as DigestFeedbackResponse).count

  let res = await post({ key, reason: 'opened', note: '画面は送らないが、来ても残さない' })
  assert.equal(res.status, 200)
  assert.equal(((await res.json()) as DigestFeedbackResponse).count, complaints, '「ありがとう、N 件目」は増やさない')
  let got = await lines()
  assert.equal(got.length, before + 2)
  assert.deepEqual([got.at(-1)!.reason, got.at(-1)!.key, got.at(-1)!.summary, got.at(-1)!.model, got.at(-1)!.persona, got.at(-1)!.note], ['opened', key, 'PR #284 出したよ、マージして？', 'qwen3:8b', 'ESFP', undefined])

  res = await post({ key: askKey, reason: 'next_ask_accepted', next_ask: '嘘の案' })
  assert.equal(res.status, 200)
  got = await lines()
  assert.deepEqual([got.at(-1)!.reason, got.at(-1)!.key, got.at(-1)!.next_ask, got.at(-1)!.summary], ['next_ask_accepted', askKey, '直して', ''], '案は鍵から引く。一言の無い行（案だけ）でも受ける')

  assert.equal((await post({ key, reason: 'next_ask_accepted' })).status, 404, '案の無い行')
  assert.equal((await post({ key: askKey, reason: 'opened' })).status, 404, '一言の無い行')
  const cross = await fetch(`${base}/api/digest/feedback`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'http://evil.example' }, body: JSON.stringify({ key, reason: 'opened' }) })
  assert.equal(cross.status, 403, '別オリジンは 403')
  assert.equal((await lines()).length, before + 3, '弾いたものは残さない')
})
