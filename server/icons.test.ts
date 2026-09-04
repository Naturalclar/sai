import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { IconStore, iconKey } from './icons.ts'

export const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3])
export const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46])

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
