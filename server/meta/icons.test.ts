import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { IconStore, iconKey } from './icons.ts'
import { JPEG_STRIPPED, JPEG_UNREADABLE, JPEG_WITH_EXIF } from '../local/imageMetadata.test.ts'
import { UNREADABLE_IMAGE_REASON } from '../local/imageMetadata.ts'
import { ICONS_STRIPPED_MARK } from './icons.ts'
import { writeFile, mkdir } from 'node:fs/promises'
import { readFile } from 'node:fs/promises'

// 形が読めない作り物は put が断る（#791）ので、読める最小のもの
export const PNG = new Uint8Array(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64'))
export const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xd9])

test('iconKey: ID から一定の幹。ID の文字はファイル名に出ない', () => {
  assert.match(iconKey('s1@sai'), /^[0-9a-f]{16}$/)
  assert.equal(iconKey('s1@sai'), iconKey('s1@sai'))
  assert.notEqual(iconKey('s1@sai'), iconKey('s1@other'))
  assert.equal(iconKey('../x/y@z').includes('/'), false)
})

test('IconStore: 無ければ空、put で置け、種類を変えると前のファイルは消え、remove で消える', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sai-icons-'))
  try {
    const store = new IconStore(join(dir, 'session-icons'))
    assert.deepEqual(await store.all(), { rev: '', entries: new Map() }, 'ディレクトリが無くても空')
    assert.equal(await store.get('a'), undefined)

    const bad = await store.put('a', new Uint8Array([1, 2, 3, 4]))
    assert.equal(bad.icon, null)
    assert.match(bad.error, /画像ファイル/)
    assert.equal(await store.get('a'), undefined, '通らなければ何も置かない')

    const put = await store.put('a', PNG)
    assert.equal(put.error, '')
    assert.equal(put.icon?.type, 'png')
    assert.equal(put.icon?.mime, 'image/png')
    assert.equal(put.icon?.size, PNG.length)
    assert.deepEqual(await readdir(join(dir, 'session-icons')), [`${iconKey('a')}.png`], 'tmp は残らない')
    const first = await store.all()
    assert.ok(first.rev)
    assert.equal(first.entries.size, 1)
    assert.equal((await store.get('a'))?.path, join(dir, 'session-icons', `${iconKey('a')}.png`))

    // 同じ状態なら同じ rev。差し替えれば変わる
    assert.equal((await store.all()).rev, first.rev)
    await new Promise((r) => setTimeout(r, 15)) // mtime が同じにならないように
    const again = await store.put('a', JPEG)
    assert.equal(again.icon?.type, 'jpeg')
    assert.deepEqual(await readdir(join(dir, 'session-icons')), [`${iconKey('a')}.jpeg`], 'PNG は消えている')
    assert.notEqual((await store.all()).rev, first.rev)

    await store.put('b', PNG)
    assert.equal((await store.all()).entries.size, 2)
    await store.remove('a')
    assert.equal(await store.get('a'), undefined)
    assert.equal((await store.get('b'))?.type, 'png', '他のは残る')
    await store.remove('nope') // 無くても失敗しない
    await store.remove('b')
    assert.deepEqual((await store.all()).rev, '', '全部消えれば rev は空')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('IconStore: 写真の EXIF は置く前に落とす（#791）', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sai-icons-exif-'))
  try {
    const store = new IconStore(join(dir, 'session-icons'))
    const put = await store.put('a', new Uint8Array(JPEG_WITH_EXIF))
    assert.equal(put.error, '')
    assert.equal(put.icon?.size, JPEG_STRIPPED.length)
    assert.deepEqual(await readFile(join(dir, 'session-icons', `${iconKey('a')}.jpeg`)), JPEG_STRIPPED)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('IconStore: 形が読めず落とせたか分からない画像は置かない。前からあるアイコンは起動時に一度だけ落として印を置く（4 回目のレビュー）', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sai-icons-strip-'))
  try {
    const d = join(dir, 'session-icons')
    await mkdir(d)
    await writeFile(join(d, `${iconKey('a')}.jpeg`), JPEG_WITH_EXIF)
    await writeFile(join(d, `${iconKey('b')}.jpeg`), JPEG_STRIPPED)
    const store = new IconStore(d)
    assert.deepEqual(await store.ready(), { checked: 2, changed: 1, marked: true })
    assert.deepEqual(await readFile(join(d, `${iconKey('a')}.jpeg`)), JPEG_STRIPPED, '名前はそのまま、中身だけ落ちる')
    assert.equal((await store.get('a'))?.size, JPEG_STRIPPED.length, '読む口も落とした後のもの')
    assert.ok((await readdir(d)).includes(ICONS_STRIPPED_MARK))
    assert.ok(!(await readdir(d)).some((n) => n.endsWith('.tmp')))
    await writeFile(join(d, `${iconKey('a')}.jpeg`), JPEG_WITH_EXIF)
    assert.deepEqual(await new IconStore(d).ready(), { checked: 0, changed: 0, marked: true }, '印があれば読まない')
    const bad = await store.put('c', new Uint8Array(JPEG_UNREADABLE))
    assert.deepEqual(bad, { icon: null, error: UNREADABLE_IMAGE_REASON })
    assert.equal(await store.get('c'), undefined)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
