import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { appendFile, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { imageBlocks, TranscriptImages } from './transcriptImages.ts'

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 1])
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>')
const img = (bytes: Buffer, media = 'image/png') => ({ type: 'image', source: { type: 'base64', media_type: media, data: bytes.toString('base64') } })
const line = (o: unknown) => JSON.stringify(o) + '\n'

let dir: string
let path: string
before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'sai-timg-'))
  path = join(dir, 's.jsonl')
  await writeFile(
    path,
    line({ type: 'user', timestamp: '2026-09-28T01:00:00.000Z', message: { role: 'user', content: [{ type: 'text', text: '[Image #1] 見て' }, img(PNG)] } }) +
      line({ type: 'assistant', timestamp: '2026-09-28T01:00:01.000Z', message: { content: [{ type: 'text', text: '"image" という語を含む返答' }] } }) +
      line({ type: 'user', timestamp: '2026-09-28T01:00:02.000Z', message: { content: [{ type: 'tool_result', content: [img(PNG), img(SVG, 'image/svg+xml')] }] } }),
  )
})
after(async () => {
  await rm(dir, { recursive: true, force: true })
})

test('imageBlocks: user のメッセージの直下は人が貼った画像、tool_result の中はツールの画像。assistant の行は見ない', () => {
  assert.deepEqual(imageBlocks({ type: 'user', message: { content: [img(PNG), { type: 'tool_result', content: [img(PNG)] }] } }).map((b) => b.from), ['user', 'agent'])
  assert.deepEqual(imageBlocks({ type: 'assistant', message: { content: [img(PNG)] } }), [])
  assert.deepEqual(imageBlocks(null), [])
})

test('TranscriptImages: 一覧の鍵でだけ読め、種類は中身から（SVG は配らない）。一覧に無い鍵・形の違う鍵は断る', async () => {
  const t = new TranscriptImages()
  const list = await t.list(path)
  assert.deepEqual(list.map((i) => [i.from, i.at]), [
    ['user', '2026-09-28T01:00:00.000Z'],
    ['agent', '2026-09-28T01:00:02.000Z'],
    ['agent', '2026-09-28T01:00:02.000Z'],
  ])
  const first = await t.read(path, list[0]!.key)
  assert.ok(first.ok && first.bytes.equals(PNG) && first.type === 'png')
  const svg = await t.read(path, list[2]!.key)
  assert.ok(!svg.ok && svg.status === 415, 'SVG は画像として配らない')
  assert.equal((await t.read(path, '1-0')).ok, false, '一覧に無い鍵')
  const bad = await t.read(path, '../etc/passwd')
  assert.ok(!bad.ok && bad.status === 400)
})

test('TranscriptImages: 追記された分だけ読み足し、書きかけの行は次に回す。作り直されたら最初から', async () => {
  const t = new TranscriptImages()
  assert.equal((await t.list(path)).length, 3)
  const next = line({ type: 'user', timestamp: '2026-09-28T01:05:00.000Z', message: { content: [img(PNG)] } })
  await appendFile(path, next.slice(0, 40)) // 書きかけ
  assert.equal((await t.list(path)).length, 3)
  await appendFile(path, next.slice(40))
  const list = await t.list(path)
  assert.equal(list.length, 4)
  assert.ok((await t.read(path, list[3]!.key)).ok)
  await writeFile(path, line({ type: 'user', timestamp: '2026-09-28T02:00:00.000Z', message: { content: [img(PNG)] } }))
  assert.deepEqual((await t.list(path)).map((i) => i.key), ['0-0'], '縮んだら最初から読み直す')
})
