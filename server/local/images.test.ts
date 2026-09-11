import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { contentDisposition, imageHeaders, imageTable, readSessionImage } from './images.ts'
import { imageKey } from '../../shared/images.ts'
import { row } from '../rows/aggregate.test.ts'

/** 先頭が PNG の印のバイト列（sniffImageType が見るのは先頭だけ） */
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0])

let dir: string
let cwd: string
let outside: string

before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'sai-images-'))
  cwd = join(dir, 'work')
  outside = join(dir, 'elsewhere')
  await mkdir(join(cwd, 'docs'), { recursive: true })
  await mkdir(join(cwd, 'dir.png'))
  await mkdir(outside)
  await writeFile(join(cwd, 'docs', 'icon.png'), PNG)
  await writeFile(join(cwd, 'fake.png'), '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>')
  await writeFile(join(outside, 'secret.png'), PNG)
  await symlink(join(outside, 'secret.png'), join(cwd, 'link.png'))
})

after(async () => {
  await rm(dir, { recursive: true, force: true })
})

test('imageTable: ターン完了の行の本文だけから拾い、鍵で引ける。同じパスは新しい行の cwd を使う', () => {
  const t = new Date()
  const table = imageTable(
    [
      row(t, 'S', { cwd: '/old', text: '[a.png](docs/a.png)' }),
      row(t, 'S', { event: 'PermissionRequest', text: '許可待ち: Read: ![w](waiting.png)' }),
      row(t, 'S', { text: 'hi', user_text: '![u](typed.png)' }),
      row(t, 'S', { cwd: '/new', text: 'また [a.png](docs/a.png)' }),
      row(t, 'S', { cwd: '', text: '![b](b.png)' }),
    ],
    '/session',
  )
  assert.deepEqual(table.get(imageKey('docs/a.png')), { src: 'docs/a.png', cwd: '/new' })
  assert.deepEqual(table.get(imageKey('b.png')), { src: 'b.png', cwd: '/session' }, '行に cwd が無ければセッションの cwd')
  assert.equal(table.get(imageKey('waiting.png')), undefined, '待ちの行の要約は見ない')
  assert.equal(table.get(imageKey('typed.png')), undefined, '自分の入力は見ない')
  assert.equal(table.size, 2)
})

const status = async (src: string, max?: number) => {
  const r = await readSessionImage({ src, cwd }, max)
  return r.ok ? 200 : r.status
}

test('readSessionImage: cwd からの相対パスと、cwd の中の絶対パスは読む', async () => {
  const rel = await readSessionImage({ src: 'docs/icon.png', cwd })
  assert.ok(rel.ok)
  assert.equal(rel.type, 'png')
  assert.equal(rel.name, 'icon.png')
  assert.ok(rel.bytes.equals(PNG))
  assert.equal(await status(join(cwd, 'docs', 'icon.png')), 200)
})

test('readSessionImage: cwd の外（絶対パス・../・外を指すシンボリックリンク）は 403', async () => {
  assert.equal(await status(join(outside, 'secret.png')), 403)
  assert.equal(await status('../elsewhere/secret.png'), 403)
  assert.equal(await status('link.png'), 403)
})

test('readSessionImage: 無い・ディレクトリ・中身が画像でない・大きすぎる・cwd が分からない', async () => {
  assert.equal(await status('docs/missing.png'), 404)
  assert.equal(await status('dir.png'), 404)
  assert.equal(await status('fake.png'), 415, '拡張子が png でも中身が SVG なら配らない')
  assert.equal(await status('docs/icon.png', 4), 413)
  const noCwd = await readSessionImage({ src: 'docs/icon.png', cwd: '' })
  assert.equal(noCwd.ok ? 200 : noCwd.status, 404)
})

test('contentDisposition: ASCII でない名前は filename* に UTF-8 で載せ、filename は _ にする', () => {
  assert.equal(contentDisposition('codex-agent-icon.png'), `attachment; filename="codex-agent-icon.png"; filename*=UTF-8''codex-agent-icon.png`)
  assert.equal(
    contentDisposition('アイコン "v2".png'),
    `attachment; filename="____ _v2_.png"; filename*=UTF-8''%E3%82%A2%E3%82%A4%E3%82%B3%E3%83%B3%20%22v2%22.png`,
  )
})

test('imageHeaders: 種類は中身から、推測と実行はさせず、ダウンロードのときだけ添付にする', () => {
  const img = { bytes: PNG, type: 'png' as const, name: 'a.png', etag: '"c-1"' }
  const view = imageHeaders(img, false)
  assert.equal(view['Content-Type'], 'image/png')
  assert.equal(view['X-Content-Type-Options'], 'nosniff')
  assert.equal(view['Content-Disposition'], undefined)
  assert.equal(imageHeaders(img, true)['Content-Disposition'], contentDisposition('a.png'))
})
