// 同じ名前のセッションを見分ける添え字（#572）。本物の createApp で、同じ project に同じ表示名を付けた 2 つのセッションに
// 始まった日の添え字が付くこと（7 日の窓で引いても、本当の始まり＝広い窓の start を使う）・名前が違えば付かないことを見る
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import type { Server } from 'node:http'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ReplyingMap, SessionsResponse } from '../shared/types.ts'
import { createApp } from './app.ts'
import { FeedStore } from './rows/store.ts'
import { localDate } from './rows/aggregate.ts'
import { row } from './rows/aggregate.test.ts'
import type { Runner } from './reply/runner.ts'

const runner: Runner = { running: () => false, snapshot: (): ReplyingMap => ({}), start: async () => {} }
const DAY = 24 * 60 * 60 * 1000

let dir: string
let server: Server
let base: string
let started: Date

const sessions = async (days = 7) => ((await (await fetch(`${base}/api/sessions?days=${days}`)).json()) as SessionsResponse).sessions
const name = (id: string, value: string) =>
  fetch(`${base}/api/sessions/${encodeURIComponent(id)}/meta`, { method: 'PUT', headers: { 'Content-Type': 'application/json', Origin: base }, body: JSON.stringify({ name: value }) })

before(async () => {
  for (const key of ['SAI_TERMINAL', 'SAI_CODEX_APP_SERVER', 'SAI_OPENCODE_SERVER']) process.env[key] = '0'
  dir = await mkdtemp(join(tmpdir(), 'sai-labels-'))
  const feedDir = join(dir, 'feed')
  await mkdir(feedDir)
  const now = new Date()
  started = new Date(now.getTime() - 20 * DAY)
  // A は 20 日前に始まって今も動いている（7 日の窓では start が今日になる）。B は 2 日前から
  const files = new Map<string, string[]>()
  const put = (at: Date, session: string) => {
    const file = `${localDate(at.toISOString())}.jsonl`
    files.set(file, [...(files.get(file) ?? []), JSON.stringify(row(at, session, { repo: 'main', project: 'Naturalclar/sai' }))])
  }
  put(started, 'A')
  put(now, 'A')
  // D は A と同じ日に始まり、12 日前に止まった（7 日の窓には居ないが、30 日の窓には居る）
  put(started, 'D')
  put(new Date(now.getTime() - 12 * DAY), 'D')
  put(new Date(now.getTime() - 2 * DAY), 'B')
  put(now, 'C')
  for (const [file, lines] of files) await writeFile(join(feedDir, file), lines.join('\n') + '\n')
  const app = createApp(new FeedStore(feedDir), join(dir, 'dist'), runner, undefined, undefined, undefined, undefined, { tmux: { run: async () => '' }, ps: async () => '' })
  server = createServer((req, res) => void app(req, res))
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const addr = server.address()
  base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`
})

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
  await rm(dir, { recursive: true, force: true })
})

test('label_suffix: 同じ project で同じ表示名なら、本当の始まりの日で見分ける。違う名前には付けない', async () => {
  assert.equal((await name('A@main', 'sai_main')).status, 200)
  assert.equal((await name('B@main', 'sai_main')).status, 200)
  assert.equal((await name('C@main', 'other')).status, 200)
  const list = await sessions()
  const by = (id: string) => list.find((s) => s.id === id)
  const day = (d: Date) => {
    const [, m, dd] = localDate(d.toISOString()).split('-')
    return `${Number(m)}/${Number(dd)}〜`
  }
  assert.equal(by('A@main')?.label_suffix, day(started), '7 日の窓でも 20 日前の始まりで付ける')
  assert.equal(by('B@main')?.label_suffix, day(new Date(Date.now() - 2 * DAY)))
  assert.equal(by('C@main')?.label_suffix, undefined, '重なっていなければ付けない')
})

test('label_suffix: 窓の広さに依らず同じ添え字になる（7 日の窓に居ない同名のセッションも数える。#578 のレビュー）', async () => {
  assert.equal((await name('D@main', 'sai_main')).status, 200)
  const narrow = await sessions(7)
  const wide = await sessions(30)
  const suffix = (list: typeof narrow, id: string) => list.find((x) => x.id === id)?.label_suffix
  // A と D は同じ日に始まったので ID の頭になる。7 日の窓（D が居ない）でも 30 日の窓でも同じ
  assert.equal(suffix(narrow, 'A@main'), 'A')
  assert.equal(suffix(wide, 'A@main'), 'A')
  assert.equal(suffix(wide, 'D@main'), 'D')
  assert.equal(suffix(narrow, 'B@main'), suffix(wide, 'B@main'))
})
