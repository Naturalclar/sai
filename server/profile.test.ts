import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ProfileStore } from './profile.ts'

test('ProfileStore: 無ければ undefined、置けば残り、rev が変わり、壊れていれば無い扱い', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sai-profile-'))
  try {
    const store = new ProfileStore(join(dir, 'profile.json'))
    assert.deepEqual(await store.get(), { rev: '', name: undefined })
    await store.set('Jesse')
    const a = await store.get()
    assert.equal(a.name, 'Jesse')
    assert.notEqual(a.rev, '')
    assert.deepEqual(JSON.parse(await readFile(join(dir, 'profile.json'), 'utf-8')), { name: 'Jesse' })
    await store.set(undefined)
    assert.equal((await store.get()).name, undefined, '消すと空のオブジェクト')
    await writeFile(join(dir, 'profile.json'), '{ broken')
    assert.equal((await store.get()).name, undefined, '壊れていたら無い扱い')
    await writeFile(join(dir, 'profile.json'), JSON.stringify({ name: 'x'.repeat(200) }))
    assert.equal((await store.get()).name, undefined, '検査に落ちる値も捨てる')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
