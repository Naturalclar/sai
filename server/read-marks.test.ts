// 未読の印（#502）。本物の createApp に一時の feed dir を渡し、一覧の unread / read_at と PUT /api/sessions/<id>/read、
// 印が read-marks.json に残って立て直しても消えないこと、既読が戻らないこと、別オリジンを断ることを見る
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import type { Server } from 'node:http'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createApp } from './app.ts'
import { FeedStore } from './rows/store.ts'
import { localDate } from './rows/aggregate.ts'
import { row } from './rows/aggregate.test.ts'
import { Approvals } from './approvals/approvals.ts'
import { UsageStore } from './local/usage.ts'
import { READ_MARKS_FILE, ReadStore } from './meta/reads.ts'
import type { SessionsResponse } from '../shared/types.ts'

let dir: string
let feedDir: string
let server: Server
let base: string
const now = Date.now()
const t = (minAgo: number) => new Date(now - minAgo * 60_000)
const iso = (d: Date) => d.toISOString().replace(/\.\d{3}Z$/, '+00:00')

const listen = async () => {
  const app = createApp(
    new FeedStore(feedDir), join(dir, 'dist'), undefined, new Approvals(), undefined, undefined, undefined,
    { tmux: { run: async () => '' }, ps: async () => '' }, undefined, undefined, undefined,
    new UsageStore(join(dir, 'codex'), join(dir, 'projects'), feedDir),
  )
  server = createServer((req, res) => void app(req, res))
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const addr = server.address()
  base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`
}
const sessionOf = async (id: string) => {
  const body = (await (await fetch(`${base}/api/sessions`)).json()) as SessionsResponse
  return body.sessions.find((s) => s.id === id)
}
const put = (id: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(`${base}/api/sessions/${encodeURIComponent(id)}/read`, { method: 'PUT', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) })

before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'sai-reads-'))
  feedDir = join(dir, 'feed')
  await mkdir(feedDir)
  // 印の起点（since）は行より前。印の無いセッションの返答は全部未読になる
  await writeFile(join(feedDir, READ_MARKS_FILE), JSON.stringify({ since: now - 60 * 60_000, sessions: {} }))
  const lines = [row(t(30), 'S1', { repo: 'repo' }), row(t(20), 'S1', { repo: 'repo' }), row(t(10), 'S1', { repo: 'repo', event: 'PermissionRequest', text: '許可待ち: Bash: ls' })]
  await writeFile(join(feedDir, `${localDate(new Date(now).toISOString())}.jsonl`), lines.map((l) => JSON.stringify(l)).join('\n') + '\n')
  await listen()
})

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
  await rm(dir, { recursive: true, force: true })
})

test('返答の数だけ未読になり、読んだ印で減り、立て直しても残る', async () => {
  assert.equal((await sessionOf('S1@repo'))?.unread, 2)
  const res = await put('S1@repo', { ts: iso(t(30)) })
  assert.equal(res.status, 200)
  assert.equal((await sessionOf('S1@repo'))?.unread, 1)
  // 立て直す
  await new Promise<void>((resolve) => server.close(() => resolve()))
  await listen()
  const s = await sessionOf('S1@repo')
  assert.equal(s?.unread, 1)
  assert.equal(s?.read_at, Date.parse(iso(t(30))))
  const saved = JSON.parse(await readFile(join(feedDir, READ_MARKS_FILE), 'utf-8')) as { sessions: Record<string, number> }
  assert.equal(saved.sessions['S1@repo'], Date.parse(iso(t(30))))
})

test('既読は戻らず、「ここから未読にする」だけが戻す', async () => {
  await put('S1@repo', { ts: iso(t(20)) })
  assert.equal((await sessionOf('S1@repo'))?.unread, undefined)
  await put('S1@repo', { ts: iso(t(30)) }) // 古い画面の既読
  assert.equal((await sessionOf('S1@repo'))?.unread, undefined)
  await put('S1@repo', { ts: iso(t(30)), back: true })
  assert.equal((await sessionOf('S1@repo'))?.unread, 2)
})

test('別オリジン・ts の無い body・窓に無いセッションは断る', async () => {
  assert.equal((await put('S1@repo', { ts: iso(t(20)) }, { Origin: 'https://evil.example' })).status, 403)
  assert.equal((await put('S1@repo', {})).status, 400)
  assert.equal((await put('nope@repo', { ts: iso(t(20)) })).status, 404)
})

test('印のファイルが無ければ「いま」を起点に作る（過去の返答を未読にしない）', async () => {
  const path = join(dir, 'fresh', READ_MARKS_FILE)
  const store = new ReadStore(path, () => 1234)
  const { marks } = await store.get()
  assert.deepEqual(marks, { since: 1234, sessions: {} })
  assert.equal(JSON.parse(await readFile(path, 'utf-8')).since, 1234)
})
