// dots が書き置いたやり取りの取り込み（#878）。一時ディレクトリの作り物のファイルだけ（本物の $TMPDIR は触らない）
import { afterEach, beforeEach, test } from 'node:test'
import assert from 'node:assert/strict'
import { chmod, mkdir, mkdtemp, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DotsDrop, DROP_FILE_MAX_BYTES, dropConversationId, parseExchange } from './drop.ts'
import { DOTS_INBOX_FILE, DotsInbox } from './inbox.ts'

let root: string
let dir: string
let inbox: DotsInbox
let drop: DotsDrop

const put = (name: string, body: unknown) => writeFile(join(dir, name), typeof body === 'string' ? body : JSON.stringify(body))
const exchange = (n: number, extra: object = {}) => ({ thread: '週末の予定', user_text: `質問 ${n}`, reply_text: `**答え** ${n}`, at: `2026-11-06T0${n}:00:00Z`, ...extra })

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'sai-dots-drop-'))
  dir = join(root, 'sai-dots')
  await mkdir(dir, { mode: 0o700 })
  inbox = new DotsInbox(join(root, DOTS_INBOX_FILE))
  drop = new DotsDrop(dir, inbox)
})

afterEach(async () => {
  drop.stop()
  await rm(root, { recursive: true, force: true })
})

test('置かれたやり取りを、dots が付けた名前の会話に取り込んで、ファイルは消す', async () => {
  await put('1.json', exchange(1))
  await put('2.json', exchange(2))
  assert.deepEqual(await drop.importOnce(), { imported: 2, rejected: 0, skipped: 0 })
  const [c] = await inbox.conversations()
  assert.ok(c)
  assert.equal(c.imported, true)
  assert.equal(c.id, dropConversationId('週末の予定', '2026-11-06T01:00:00Z'))
  assert.deepEqual(c.requests.map((r) => [r.message.source, r.message.text, r.message.thread, r.state, r.replies.map((x) => x.text)]), [
    ['chatgpt-human', '質問 1', '週末の予定', 'done', ['**答え** 1']],
    ['chatgpt-human', '質問 2', '週末の予定', 'done', ['**答え** 2']],
  ])
  assert.deepEqual(await readdir(dir), [])
})

test('名前が無ければ日ごと（Asia/Tokyo）にまとめる', async () => {
  // 日本時間では 11/6 と 11/7
  await put('a.json', exchange(1, { thread: undefined, at: '2026-11-06T10:00:00Z' }))
  await put('b.json', exchange(2, { thread: undefined, at: '2026-11-06T16:00:00Z' }))
  await drop.importOnce()
  assert.equal((await inbox.conversations()).length, 2)
  assert.notEqual(dropConversationId(undefined, '2026-11-06T10:00:00Z'), dropConversationId(undefined, '2026-11-06T16:00:00Z'))
  assert.equal(dropConversationId(undefined, '2026-11-06T10:00:00Z'), dropConversationId(undefined, '2026-11-06T14:59:00Z'))
})

test('同じ中身を 2 回置かれても 1 件。書きかけ（.tmp）は読まない', async () => {
  await put('1.json', exchange(1))
  await drop.importOnce()
  await put('again.json', exchange(1))
  await put('3.json.tmp', exchange(3))
  assert.deepEqual(await drop.importOnce(), { imported: 0, rejected: 0, skipped: 0 })
  assert.equal((await inbox.conversations())[0]?.requests.length, 1)
  assert.deepEqual(await readdir(dir), ['3.json.tmp'])
})

test('壊れたもの・形の違うもの・大きすぎるものは捨てる', async () => {
  await put('broken.json', '{')
  await put('array.json', [1])
  await put('noreply.json', { user_text: 'x' })
  await put('big.json', { user_text: 'x', reply_text: 'y'.repeat(DROP_FILE_MAX_BYTES) })
  assert.deepEqual(await drop.importOnce(), { imported: 0, rejected: 4, skipped: 0 })
  assert.deepEqual(await readdir(dir), [])
  assert.deepEqual(await inbox.conversations(), [])
})

test('シンボリックリンクは開かず、消しもしない', async () => {
  const outside = join(root, 'outside.json')
  await writeFile(outside, JSON.stringify(exchange(1)))
  await symlink(outside, join(dir, 'link.json'))
  assert.deepEqual(await drop.importOnce(), { imported: 0, rejected: 0, skipped: 1 })
  assert.deepEqual(await readdir(dir), ['link.json'])
})

test('フォルダがほかの人に書ける・持ち主が違う・シンボリックリンクなら、何も取り込まない', async () => {
  await put('1.json', exchange(1))
  await chmod(dir, 0o777)
  assert.deepEqual(await drop.importOnce(), { imported: 0, rejected: 0, skipped: 0 })
  await chmod(dir, 0o700)
  assert.deepEqual(await new DotsDrop(dir, inbox, { uid: 123456 }).importOnce(), { imported: 0, rejected: 0, skipped: 0 })
  const link = join(root, 'link-dir')
  await symlink(dir, link)
  assert.deepEqual(await new DotsDrop(link, inbox).importOnce(), { imported: 0, rejected: 0, skipped: 0 })
  assert.deepEqual(await readdir(dir), ['1.json'])
  // フォルダが無くても落ちない
  assert.deepEqual(await new DotsDrop(join(root, 'none'), inbox).importOnce(), { imported: 0, rejected: 0, skipped: 0 })
})

test('同時に呼ばれても 1 回ぶんだけ取り込む', async () => {
  await put('1.json', exchange(1))
  const [a, b] = await Promise.all([drop.importOnce(), drop.importOnce()])
  assert.equal(a, b)
  assert.equal((await inbox.conversations())[0]?.requests.length, 1)
})

test('読み方: 名前は空白を詰めて縮め、時刻は読めなければ使わない', () => {
  const p = parseExchange({ thread: '  a \n b  ', user_text: ' q ', reply_text: ' r ', at: 'nope' })
  assert.deepEqual(p, { thread: 'a b', user_text: 'q', reply_text: 'r' })
  assert.equal(typeof parseExchange({ user_text: 'q', reply_text: '   ' }), 'string')
  assert.equal(typeof parseExchange({ user_text: 'x'.repeat(20001), reply_text: 'r' }), 'string')
})
