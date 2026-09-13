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
  await writeFile(join(dir, `${localDate(now.toISOString())}.jsonl`), JSON.stringify(r) + '\n')

  // 一言はすでに作ってあることにする（口は叩かない）
  const store = new DigestStore(join(dir, 'digest.jsonl'))
  await writeFile(store.path, JSON.stringify({ key, persona: 'ESFP', summary: 'PR #284 出したよ、マージして？', model: 'qwen3:8b', ts: now.toISOString() }) + '\n')
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

test('note は省ける。2 件目も後ろに足される', async () => {
  const res = await post({ key, reason: 'long' })
  assert.equal(res.status, 200)
  assert.equal(((await res.json()) as DigestFeedbackResponse).count, 2)
  const got = await lines()
  assert.equal(got.length, 2)
  assert.equal(got[1]!.note, undefined)
  assert.equal(got[1]!.reason, 'long')
})
