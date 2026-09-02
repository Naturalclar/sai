import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MetaStore } from './meta.ts'
import { normalizeMeta } from '../shared/meta.ts'

test('normalizeMeta', () => {
  assert.deepEqual(normalizeMeta({ name: ' a  b ', icon: '🧪' }), { meta: { name: 'a b', icon: '🧪' }, error: '' })
  assert.deepEqual(normalizeMeta({}), { meta: {}, error: '' })
  assert.deepEqual(normalizeMeta({ name: '', icon: '' }), { meta: {}, error: '' }, '空は「消す」')
  assert.deepEqual(normalizeMeta({ name: null, icon: undefined }), { meta: {}, error: '' })
  assert.equal(normalizeMeta({ icon: '🧪🧪' }).error !== '', true)
  assert.equal(normalizeMeta({ icon: '👨‍👩‍👧' }).error, '', 'ZWJ 絵文字は1文字')
  assert.equal(normalizeMeta({ icon: '🇯🇵' }).error, '', '国旗も1文字')
  assert.equal(normalizeMeta(null).error !== '', true)
  assert.equal(normalizeMeta('x').error !== '', true)
})

test('MetaStore: 無ければ空、set で書け、空にすると消え、壊れたファイルは空扱い', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sai-meta-'))
  try {
    const path = join(dir, 'sub', 'session-meta.json')
    const store = new MetaStore(path)
    assert.deepEqual(await store.all(), { rev: '', entries: {} })
    assert.equal(await store.get('a'), undefined)

    assert.deepEqual(await store.set('a', { name: 'A' }), { name: 'A' })
    const first = await store.all()
    assert.ok(first.rev)
    assert.deepEqual(first.entries, { a: { name: 'A' } })
    assert.deepEqual((await readdir(join(dir, 'sub'))), ['session-meta.json'], 'tmp は残らない')

    await store.set('b', { icon: '🧪' })
    assert.deepEqual((await store.all()).entries, { a: { name: 'A' }, b: { icon: '🧪' } })
    assert.equal(await store.set('a', {}), undefined)
    assert.deepEqual((await store.all()).entries, { b: { icon: '🧪' } })

    // 同じ状態なら同じ rev、変われば変わる
    const r1 = (await store.all()).rev
    assert.equal((await store.all()).rev, r1)
    await store.set('c', { name: 'C' })
    assert.notEqual((await store.all()).rev, r1)

    // 壊れたファイル・変な値
    await writeFile(path, '{ broken')
    assert.deepEqual((await store.all()).entries, {})
    await writeFile(path, JSON.stringify({ ok: { name: 'x' }, bad: { icon: '🧪🧪' }, empty: {}, junk: 1 }))
    assert.deepEqual((await store.all()).entries, { ok: { name: 'x' } }, '通らない値は落とす')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
