import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MetaStore } from './meta.ts'
import { isEmptyMeta, mergeMeta, normalizeMeta } from '../shared/meta.ts'

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

test('normalizeMeta: archived_at は ISO に正規化、空は消す、読めない時刻は弾く', () => {
  assert.deepEqual(normalizeMeta({ archived_at: '2026-09-02T01:02:03+09:00' }), { meta: { archived_at: '2026-09-01T16:02:03.000Z' }, error: '' })
  assert.deepEqual(normalizeMeta({ archived_at: '' }), { meta: {}, error: '' })
  assert.deepEqual(normalizeMeta({ archived_at: null }), { meta: {}, error: '' })
  assert.notEqual(normalizeMeta({ archived_at: 'yesterday' }).error, '')
  assert.notEqual(normalizeMeta({ archived_at: 1 }).error, '')
  assert.equal(isEmptyMeta({ archived_at: '2026-09-01T16:02:03.000Z' }), false)
})

test('mergeMeta: 無いキーは据え置き、null / 空文字は消す', () => {
  const cur = { name: 'A', icon: '🧪', archived_at: '2026-09-01T00:00:00.000Z' }
  assert.deepEqual(mergeMeta(cur, { name: 'B' }).meta, { ...cur, name: 'B' })
  assert.deepEqual(mergeMeta(cur, { icon: null }).meta, { name: 'A', archived_at: cur.archived_at })
  assert.deepEqual(mergeMeta(cur, { archived_at: '' }).meta, { name: 'A', icon: '🧪' })
  assert.deepEqual(mergeMeta(cur, {}).meta, cur)
  assert.deepEqual(mergeMeta(cur, { name: '', icon: '', archived_at: null }).meta, {})
  assert.notEqual(mergeMeta(cur, { name: 1 }).error, '')
  assert.notEqual(mergeMeta(cur, null).error, '')
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
