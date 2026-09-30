// GET /api/sessions/<id>/turn?ts=（#537）。要対応の「終了」の行で、一言のもとになった本文を開くための口。
// 本物の createApp に一時の feed dir を渡して、ts で名指ししたターン完了の行が返ること・待ちの行や別のセッションを返さないことを見る
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
import { Approvals } from './approvals/approvals.ts'
import type { SessionTurnResponse } from '../shared/types.ts'

let dir: string
let server: Server
let base: string
const at = (sec: number) => new Date(Date.now() - 60_000 + sec * 1000)
const iso = (d: Date) => row(d, 'x').ts
const turn = async (id: string, ts?: string) => {
  const res = await fetch(`${base}/api/sessions/${encodeURIComponent(id)}/turn${ts === undefined ? '' : `?ts=${encodeURIComponent(ts)}`}`)
  return { status: res.status, body: (await res.json()) as SessionTurnResponse }
}

before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'sai-turn-'))
  const feedDir = join(dir, 'feed')
  await mkdir(feedDir)
  const long = '# 見出し\n\n' + '長い本文。'.repeat(200)
  const lines = [
    row(at(0), 'S1', { repo: 'repo', text: '前のターンの返答' }),
    row(at(10), 'S1', { repo: 'repo', text: long, clipped: ['text'] }),
    // ターン完了のあとの待ちの行（本文ではない）
    row(at(20), 'S1', { repo: 'repo', event: 'Notification', text: '許可待ち: Bash: ls' }),
    row(at(10), 'S2', { repo: 'repo', text: '別のセッション' }),
  ]
  await writeFile(join(feedDir, `${localDate(new Date().toISOString())}.jsonl`), lines.map((l) => JSON.stringify(l)).join('\n') + '\n')
  const app = createApp(new FeedStore(feedDir), join(dir, 'dist'), undefined, new Approvals(), undefined, undefined, undefined, { tmux: { run: async () => '' }, ps: async () => '' })
  server = createServer((req, res) => void app(req, res))
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const addr = server.address()
  base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`
})

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
  await rm(dir, { recursive: true, force: true })
})

test('ts で名指ししたターン完了の行を、本文を切らずに返す（一覧の last_text は 1 行目の 120 字だけ）', async () => {
  const { status, body } = await turn('S1@repo', iso(at(10)))
  assert.equal(status, 200)
  assert.equal(body.id, 'S1@repo')
  assert.ok(body.row?.text.startsWith('# 見出し\n\n長い本文。'))
  assert.equal(body.row?.text.length, '# 見出し\n\n'.length + '長い本文。'.length * 200, '全文')
  assert.deepEqual(body.row?.clipped, ['text'], '記録のときに切られた印も運ぶ（画面が「ここで切れています」を出す）')
})

test('一言を作ったあとで新しいターンが届いていても、名指しした ts の方を返す', async () => {
  const { body } = await turn('S1@repo', iso(at(0)))
  assert.equal(body.row?.text, '前のターンの返答')
})

test('ts が無ければ一番新しいターン完了。待ちの行と別のセッションの行は返さない', async () => {
  const { body } = await turn('S1@repo')
  assert.ok(body.row?.text.startsWith('# 見出し'), '待ちの行（あとに書かれた）ではない')
  assert.equal((await turn('S1@repo', iso(at(20)))).body.row, null, '待ちの行の ts を渡しても本文にはならない')
  assert.equal((await turn('S2@repo', iso(at(10)))).body.row?.text, '別のセッション')
})

test('一覧に居ないセッションは 404', async () => {
  assert.equal((await turn('nope@repo', iso(at(10)))).status, 404)
})
