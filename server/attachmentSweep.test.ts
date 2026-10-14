// 添付の原本の寿命（#792）。作り物の置き場だけを使う（本物の ~/.agent-feed には触らない）
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import type { Server } from 'node:http'
import { mkdir, mkdtemp, readdir, readFile, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SessionsResponse } from '../shared/types.ts'
import { createApp } from './app.ts'
import { Approvals } from './approvals/approvals.ts'
import { Authenticator } from './auth.ts'
import { BuildFreshness } from './local/buildFreshness.ts'
import { THUMB_MIN_BYTES } from './local/thumbnails.ts'
import type { ThumbMaker } from './local/thumbnails.ts'
import { ATTACHMENT_TTL_DAYS, AttachmentSweeper } from './reply/attachmentSweep.ts'
import { AttachmentStore, attachmentDir, KEPT_THUMB_SUBDIR } from './reply/attachments.ts'
import { jpegSegment } from './local/imageMetadata.ts'
import { localDate } from './rows/aggregate.ts'
import { row } from './rows/aggregate.test.ts'
import { FeedStore } from './rows/store.ts'
import { attachmentTtlDays } from './main.ts'

/** 読める JPEG で、だいたい size バイト（落とす物は無い） */
const jpegOf = (size: number) => Buffer.concat([Buffer.from([0xff, 0xd8]), jpegSegment(0xda, Buffer.alloc(10)), Buffer.alloc(Math.max(0, size - 18), 0x12), Buffer.from([0xff, 0xd9])])
const BIG = jpegOf(THUMB_MIN_BYTES + 100)
const SMALL = jpegOf(1000)
const THUMB = Buffer.from([0xff, 0xd8, 0xff, 0xd9])
const DAY = 86_400_000

/** 偽の縮める口。`fail` なら作れない */
const maker = (fail = false): ThumbMaker & { calls: number } => ({
  calls: 0,
  async thumb() {
    this.calls++
    return fail ? { kind: 'unavailable' } : { kind: 'thumb', bytes: THUMB, type: 'jpeg' }
  },
})

async function seed(root: string, dir: string, name: string, bytes: Buffer, ageDays: number, now: number) {
  await mkdir(join(root, dir), { recursive: true })
  const path = join(root, dir, name)
  await writeFile(path, bytes)
  const at = new Date(now - ageDays * DAY)
  await utimes(path, at, at)
  return path
}

test('掃除: 寿命を過ぎた大きい原本だけ消し、軽い版が無ければ作ってから消す。小さいもの・新しいもの・文字のファイルは残す。ログは 0 件でも書く', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sai-sweep-'))
  try {
    const now = Date.UTC(2026, 9, 14)
    const d = attachmentDir('S1@r')
    const old = await seed(root, d, `${'a'.repeat(16)}.jpeg`, BIG, 31, now)
    const fresh = await seed(root, d, `${'b'.repeat(16)}.jpeg`, BIG, 29, now)
    const small = await seed(root, d, `${'c'.repeat(16)}.jpeg`, SMALL, 40, now)
    const txt = await seed(root, d, `${'d'.repeat(16)}.txt`, Buffer.alloc(THUMB_MIN_BYTES + 1, 0x41), 40, now)
    await writeFile(join(root, d, `${'d'.repeat(16)}.txt.name`), 'log.txt')
    const store = new AttachmentStore(root)
    const thumbs = maker()
    const log = join(root, '..', `sai-sweep-${process.pid}.log`)
    const sweeper = new AttachmentSweeper(store, thumbs, { ttlMs: ATTACHMENT_TTL_DAYS * DAY, logPath: log, now: () => now })
    const r = await sweeper.run()
    assert.equal(r.deleted, 1)
    assert.equal(r.freed_bytes, BIG.length)
    assert.equal(r.thumbs_made, 1)
    assert.equal(r.kept_small, 1)
    assert.equal(r.originals, 3)
    assert.equal(thumbs.calls, 1, '軽い版を作ったのは消した 1 枚だけ')
    await assert.rejects(readFile(old), '寿命を過ぎた原本は消える')
    assert.deepEqual(await readFile(join(root, d, KEPT_THUMB_SUBDIR, `${'a'.repeat(16)}.jpg`)), THUMB, '軽い版は原本の隣に残る')
    for (const p of [fresh, small, txt]) await readFile(p)
    assert.equal(await store.usablePath(old), join(root, d, KEPT_THUMB_SUBDIR, `${'a'.repeat(16)}.jpg`), '返信に渡すパスは軽い版に落ちる')
    assert.equal(await store.usablePath(fresh), fresh)
    // 2 回目は消すものが無い。それでもログに 1 行書く
    const again = await sweeper.run()
    assert.equal(again.deleted, 0)
    assert.equal(again.originals, 2)
    const lines = (await readFile(log, 'utf-8')).trim().split('\n')
    assert.equal(lines.length, 2)
    assert.equal(JSON.parse(lines[1]!).deleted, 0)
    assert.equal(JSON.parse(lines[1]!).ttl_days, 30)
    assert.equal(again.total_files, 5, '原本 2 + 軽い版 1 + 文字のファイル 1 + 元の名前 1')
    await rm(log, { force: true })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('掃除: 軽い版が作れなければ原本を消さない。寿命 0 なら消さずに測るだけ。しきい値を超えれば over() が返す', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sai-sweep-keep-'))
  try {
    const now = Date.UTC(2026, 9, 14)
    const d = attachmentDir('S1@r')
    const old = await seed(root, d, `${'a'.repeat(16)}.jpeg`, BIG, 40, now)
    const store = new AttachmentStore(root)
    const noThumb = new AttachmentSweeper(store, maker(true), { ttlMs: 30 * DAY, now: () => now, warnBytes: 10 })
    const r = await noThumb.run()
    assert.deepEqual([r.deleted, r.kept_no_thumb], [0, 1])
    await readFile(old)
    assert.deepEqual(noThumb.over(), { bytes: BIG.length, threshold: 10 }, 'しきい値を超えている')
    assert.ok(!(await readdir(join(root, d))).includes(KEPT_THUMB_SUBDIR), '作れなかったので軽い版の置き場も無い')
    const off = new AttachmentSweeper(store, maker(), { ttlMs: 0, now: () => now })
    const r2 = await off.run()
    assert.deepEqual([r2.deleted, r2.originals, r2.total_bytes], [0, 1, BIG.length])
    assert.equal(off.over(), null, '既定のしきい値（500MB）は超えていない')
    await readFile(old)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('attachmentTtlDays: 既定 30。数でなければ既定、負は 0', () => {
  assert.equal(attachmentTtlDays({}), 30)
  assert.equal(attachmentTtlDays({ SAI_ATTACHMENT_TTL_DAYS: '7' }), 7)
  assert.equal(attachmentTtlDays({ SAI_ATTACHMENT_TTL_DAYS: '0' }), 0)
  assert.equal(attachmentTtlDays({ SAI_ATTACHMENT_TTL_DAYS: '-3' }), 0)
  assert.equal(attachmentTtlDays({ SAI_ATTACHMENT_TTL_DAYS: 'abc' }), 30)
})

// 配る口と一覧のバナー
let dir: string
let server: Server
let base: string
const thumbs = maker()

before(async () => {
  process.env.AGENT_FEED_HOST = 'testmac'
  dir = await mkdtemp(join(tmpdir(), 'sai-sweep-app-'))
  const now = new Date()
  await writeFile(join(dir, `${localDate(now.toISOString())}.jsonl`), JSON.stringify(row(now, 'A1', { repo: 'r', cwd: dir, project: 'o/r' })) + '\n')
  const app = createApp(
    new FeedStore(dir), join(dir, 'dist'), undefined, new Approvals(), new BuildFreshness(join(dir, 'dist'), [], 0), undefined, new Authenticator(async () => null),
    { tmux: { run: async () => '' }, ps: async () => '', thumbs, attachmentSweep: { ttlMs: 30 * DAY, warnBytes: 1, intervalMs: 100 } },
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

test('配る口: ?thumb= で作った軽い版は原本の隣に残り、原本が消えたあとは元のまま・軽い版のどちらの URL でも軽い版を配る（X-SAI-Attachment: thumb）', async () => {
  const d = attachmentDir('A1@r')
  const sub = join(dir, 'attachments', d)
  await mkdir(sub, { recursive: true })
  const name = `${'e'.repeat(16)}.jpeg`
  await writeFile(join(sub, name), BIG)
  const url = `${base}/api/attachments/${d}/${name}`
  const before = thumbs.calls
  const t = await fetch(`${url}?thumb=2`)
  assert.equal(t.status, 200)
  assert.deepEqual(Buffer.from(await t.arrayBuffer()), THUMB)
  assert.deepEqual(await readFile(join(sub, KEPT_THUMB_SUBDIR, `${'e'.repeat(16)}.jpg`)), THUMB, '原本の隣に残す')
  assert.equal((await fetch(`${url}?thumb=2`)).status, 200)
  assert.equal(thumbs.calls, before + 1, '2 回目は置いてある軽い版を配る（縮め直さない）')
  assert.equal((await fetch(url)).headers.get('x-sai-attachment'), null, '原本があるうちは原本')
  await rm(join(sub, name))
  for (const u of [url, `${url}?thumb=2`, `${url}?download=1`]) {
    const res = await fetch(u)
    assert.equal(res.status, 200, u)
    assert.equal(res.headers.get('x-sai-attachment'), 'thumb', u)
    assert.deepEqual(Buffer.from(await res.arrayBuffer()), THUMB)
  }
  assert.equal((await fetch(`${base}/api/attachments/${d}/${'f'.repeat(16)}.jpeg`)).status, 404, '原本も軽い版も無ければ 404')
  // 置き場がしきい値（1 バイト）を超えているので、次の掃除（テストでは 100ms ごと）のあと一覧に出る
  let list: SessionsResponse | null = null
  for (let i = 0; i < 50 && !list?.attachments_over; i++) {
    await new Promise((r) => setTimeout(r, 100))
    list = (await (await fetch(`${base}/api/sessions?days=2`)).json()) as SessionsResponse
  }
  assert.ok(list?.attachments_over && list.attachments_over.bytes > 1 && list.attachments_over.threshold === 1, JSON.stringify(list?.attachments_over))
})
