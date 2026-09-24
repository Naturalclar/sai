// #465。今まで使ったアイコン画像の履歴
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readdir, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { IconStore, iconKey } from './icons.ts'
import { IconHistory, historyKey, isHistoryKey } from './iconHistory.ts'

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64')
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46])

async function setup() {
  const dir = await mkdtemp(join(tmpdir(), 'sai-icon-history-'))
  const icons = new IconStore(join(dir, 'session-icons'))
  return { dir, icons, history: new IconHistory(join(dir, 'icon-history'), join(dir, 'icon-history.json'), icons) }
}

test('isHistoryKey: 16 桁の小文字の 16 進だけ（パスに化けるものは通さない）', () => {
  assert.equal(isHistoryKey(historyKey(PNG)), true)
  for (const bad of ['', '../../etc/passwd', '0123456789ABCDEF', '0123456789abcde', '0123456789abcdef0', '0123456789abcde/']) assert.equal(isHistoryKey(bad), false, bad)
})

test('IconHistory: 同じ中身は 1 つにまとまり、使った時刻で新しい順に並ぶ', async () => {
  const { history } = await setup()
  assert.deepEqual(await history.list(), [])
  const a = await history.add(PNG, new Date('2026-09-01T00:00:00Z'))
  const b = await history.add(JPEG, new Date('2026-09-02T00:00:00Z'))
  assert.deepEqual((await history.list()).map((e) => e.key), [b, a])
  // もう一度使うと上に来る。ファイルは増えない
  assert.equal(await history.add(PNG, new Date('2026-09-03T00:00:00Z')), a)
  assert.deepEqual((await history.list()).map((e) => [e.key, e.type]), [[a, 'png'], [b, 'jpeg']])
  assert.deepEqual(new Uint8Array((await history.read(a))!), new Uint8Array(PNG))
  assert.equal(await history.add(Buffer.from('not an image')), '', '画像でなければ入れない')
  assert.equal((await history.list()).length, 2)
})

test('IconHistory: 消したら読めない。無い鍵・形の違う鍵は false / null', async () => {
  const { history } = await setup()
  const key = await history.add(PNG)
  assert.equal(await history.remove(key), true)
  assert.equal(await history.read(key), null)
  assert.equal(await history.remove(key), false)
  assert.equal(await history.remove('../icon-history'), false)
  assert.equal(await history.read('../../etc/passwd'), null)
})

test('IconHistory: いまの session-icons/ を 1 度だけ取り込む。消したものは次に作り直しても戻らない', async () => {
  const { dir, icons, history } = await setup()
  await icons.put('A@r', PNG)
  await icons.put('B@r', PNG) // 同じ画像を 2 つのセッションに付けていた（実データで 3 組）
  await icons.put('C@r', JPEG)
  const seeded = await history.list()
  assert.deepEqual(seeded.map((e) => e.key).sort(), [historyKey(PNG), historyKey(JPEG)].sort(), '同じ画像は 1 つに')
  await history.remove(historyKey(JPEG))
  const again = new IconHistory(join(dir, 'icon-history'), join(dir, 'icon-history.json'), icons)
  assert.deepEqual((await again.list()).map((e) => e.key), [historyKey(PNG)], '取り込んだことを覚えているので、消したものは戻らない')
  // セッションのアイコンそのものは触らない
  assert.ok(await icons.get('C@r'))
  assert.equal(iconKey('C@r').length, 16)
})

test('IconHistory: json が壊れていても、ファイルがあれば出す', async () => {
  const { dir, history } = await setup()
  const key = await history.add(PNG)
  await writeFile(join(dir, 'icon-history.json'), '{broken')
  await mkdir(join(dir, 'icon-history'), { recursive: true })
  assert.ok((await readdir(join(dir, 'icon-history'))).some((n) => n.startsWith(key)))
  assert.equal((await history.list())[0]?.key, key)
})
