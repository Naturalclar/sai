// GET /api/sessions/<id>/images/<key>（#321）。本物の createApp に一時の feed dir と作業ディレクトリを渡して、
// 返答の本文に書かれた作業ディレクトリの中の画像だけが配られ、表に無い鍵・自分の入力に書いたパス・外のファイル・
// 別のマシンのセッションは配られないことを見る
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
import { sessionImageUrl } from '../shared/images.ts'

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0])

let dir: string
let secret: string
let server: Server
let base: string

const get = (id: string, src: string, init?: RequestInit, query = '') => fetch(`${base}${sessionImageUrl(id, src)}${query}`, init)

before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'sai-img-'))
  const feedDir = join(dir, 'feed')
  const cwd = join(dir, 'work')
  await mkdir(feedDir)
  await mkdir(join(cwd, 'docs'), { recursive: true })
  await mkdir(join(dir, 'elsewhere'))
  await writeFile(join(cwd, 'docs', 'codex-agent-icon.png'), PNG)
  await writeFile(join(cwd, 'docs', 'typed.png'), PNG)
  secret = join(dir, 'elsewhere', 'secret.png')
  await writeFile(secret, PNG)

  const now = new Date()
  const lines = [
    row(now, 'S1', {
      repo: 'repo',
      cwd,
      text: `できました [codex-agent-icon.png](docs/codex-agent-icon.png)\n\n外 ![s](${secret})`,
      user_text: '![typed](docs/typed.png) を見て',
    }),
    // 別のマシンで記録された行。同じパスのファイルがこちらにあっても別物
    row(now, 'S2', { repo: 'repo', cwd, host: 'far-away-machine', text: '![i](docs/codex-agent-icon.png)' }),
  ]
  await writeFile(join(feedDir, `${localDate(now.toISOString())}.jsonl`), lines.map((l) => JSON.stringify(l)).join('\n') + '\n')

  const app = createApp(new FeedStore(feedDir), join(dir, 'dist'))
  server = createServer((req, res) => void app(req, res))
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const addr = server.address()
  base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`
})

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
  await rm(dir, { recursive: true, force: true })
})

test('本文に書かれた画像を中身の種類で配る。推測と実行はさせず、変わっていなければ 304', async () => {
  const res = await get('S1@repo', 'docs/codex-agent-icon.png')
  assert.equal(res.status, 200)
  assert.equal(res.headers.get('content-type'), 'image/png')
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff')
  assert.equal(res.headers.get('content-disposition'), null, 'ダウンロードでなければ添付にしない（<img> で出す）')
  assert.ok(Buffer.from(await res.arrayBuffer()).equals(PNG))
  const etag = res.headers.get('etag')
  assert.ok(etag)
  assert.equal((await get('S1@repo', 'docs/codex-agent-icon.png', { headers: { 'If-None-Match': etag } })).status, 304)
})

test('?download=1 は名前を付けて添付にする', async () => {
  const res = await get('S1@repo', 'docs/codex-agent-icon.png', undefined, '?download=1')
  assert.equal(res.status, 200)
  assert.match(res.headers.get('content-disposition') ?? '', /^attachment; filename="codex-agent-icon\.png"/)
})

test('表に無い鍵・自分の入力に書いたパスは 404、本文に書かれていても作業ディレクトリの外は 403', async () => {
  assert.equal((await fetch(`${base}/api/sessions/S1%40repo/images/0123456789abcdef`)).status, 404)
  assert.equal((await fetch(`${base}/api/sessions/S1%40repo/images/..%2F..%2Fetc%2Fpasswd`)).status, 404)
  assert.equal((await get('S1@repo', 'docs/typed.png')).status, 404, 'ファイルはあるが、返答の本文には書かれていない')
  assert.equal((await get('S1@repo', secret)).status, 403)
})

test('別のマシンのセッション・知らないセッションは 404、書き込みは 405', async () => {
  assert.equal((await get('S2@repo', 'docs/codex-agent-icon.png')).status, 404)
  assert.equal((await get('nope@repo', 'docs/codex-agent-icon.png')).status, 404)
  assert.equal((await get('S1@repo', 'docs/codex-agent-icon.png', { method: 'POST' })).status, 405)
})
