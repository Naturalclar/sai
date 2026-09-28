// GET /api/sessions/<id>/gallery と /transcript-images/<key>（#504）。本物の createApp に一時の feed dir・作業ディレクトリ・
// Claude の projects を渡して、返答・自分の入力・添付・transcript の画像が一覧に並び、transcript の画像は一覧の鍵でだけ配られ、
// 別のマシンのセッションは空になることを見る
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import type { Server } from 'node:http'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createApp } from './app.ts'
import { FeedStore } from './rows/store.ts'
import { localDate } from './rows/aggregate.ts'
import { row } from './rows/aggregate.test.ts'
import { ProgressReader } from './local/progress.ts'
import { claudeProjectName } from '../shared/progress.ts'
import { Approvals } from './approvals/approvals.ts'
import { UsageStore } from './local/usage.ts'
import type { GalleryResponse } from '../shared/types.ts'

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 2])

let dir: string
let server: Server
let base: string
const gallery = async (id: string) => (await (await fetch(`${base}/api/sessions/${encodeURIComponent(id)}/gallery`)).json()) as GalleryResponse

before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'sai-gallery-'))
  const feedDir = join(dir, 'feed')
  const cwd = join(dir, 'work')
  const projects = join(dir, 'projects')
  await mkdir(feedDir)
  await mkdir(cwd)
  await writeFile(join(cwd, 'out.png'), PNG)
  await writeFile(join(cwd, 'mine.png'), PNG)
  // 端末で貼った画像が入っている transcript
  await mkdir(join(projects, claudeProjectName(cwd)), { recursive: true })
  const now = new Date()
  await writeFile(
    join(projects, claudeProjectName(cwd), 'S1.jsonl'),
    JSON.stringify({ type: 'user', timestamp: now.toISOString(), message: { content: [{ type: 'text', text: '[Image #1]' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG.toString('base64') } }] } }) + '\n',
  )
  const lines = [
    row(now, 'S1', { repo: 'repo', cwd, agent: 'claude', text: 'できました ![out](out.png)', user_text: `[Image #1] と ${join(cwd, 'mine.png')} を見て` }),
    row(now, 'S2', { repo: 'repo', cwd, agent: 'claude', host: 'far-away-machine', text: '![out](out.png)' }),
  ]
  await writeFile(join(feedDir, `${localDate(now.toISOString())}.jsonl`), lines.map((l) => JSON.stringify(l)).join('\n') + '\n')

  const app = createApp(
    new FeedStore(feedDir), join(dir, 'dist'), undefined, new Approvals(), undefined, undefined, undefined,
    { tmux: { run: async () => '' }, ps: async () => '' }, undefined, undefined, undefined,
    new UsageStore(join(dir, 'codex'), projects, feedDir),
    new ProgressReader(projects, join(dir, 'codex')),
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

test('一覧に返答の画像・自分の入力の画像・端末で貼った画像が並び、どれも開ける。貼った画像には飛び先の行がある', async () => {
  const { items } = await gallery('S1@repo')
  assert.deepEqual(items.map((i) => [i.source, i.from]).sort(), [['text', 'agent'], ['text', 'user'], ['transcript', 'user']])
  for (const item of items) {
    const res = await fetch(`${base}${item.url}`)
    assert.equal(res.status, 200, `${item.name} が開ける`)
    assert.equal(res.headers.get('content-type'), 'image/png')
    assert.ok(Buffer.from(await res.arrayBuffer()).equals(PNG))
  }
  const pasted = items.find((i) => i.source === 'transcript')!
  assert.ok(pasted.ts, '貼った画像も付ける行がある（自分の入力のバブル）')
  assert.equal(pasted.name, '貼った画像')
})

test('transcript の画像は一覧の鍵でだけ。知らない鍵・形の違う鍵は断り、別のマシンのセッションは一覧が空', async () => {
  assert.equal((await fetch(`${base}/api/sessions/S1%40repo/transcript-images/999-0`)).status, 404)
  assert.equal((await fetch(`${base}/api/sessions/S1%40repo/transcript-images/..%2F..%2Fetc%2Fpasswd`)).status, 400)
  assert.deepEqual((await gallery('S2@repo')).items, [])
  assert.equal((await fetch(`${base}/api/sessions/nope%40repo/gallery`)).status, 404)
})
