// 成果の確認の記録（#903）。置き場は一時ディレクトリ（本物の ~/.agent-feed は触らない）
import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RESULT_CHECKS_MAX, ResultChecks } from './resultChecks.ts'

const dirs: string[] = []
const tmp = async () => {
  const d = await mkdtemp(join(tmpdir(), 'sai-result-checks-'))
  dirs.push(d)
  return join(d, 'result-checks.json')
}
after(async () => {
  for (const d of dirs) await rm(d, { recursive: true, force: true })
})

test('ResultChecks: 無ければ空で作らない。付けた・外したがファイルに残り、作り直しても読める', async () => {
  const path = await tmp()
  const store = new ResultChecks(path, () => new Date('2026-11-01T00:00:00.000Z'))
  assert.equal((await store.all()).size, 0)
  await assert.rejects(readFile(path, 'utf-8'), '読むだけでは作らない')
  assert.equal(await store.set('k1', true), '2026-11-01T00:00:00.000Z')
  assert.equal((await new ResultChecks(path).all()).get('k1'), '2026-11-01T00:00:00.000Z', '立て直しても消えない')
  // もう一度付けても時刻は変えない
  assert.equal(await new ResultChecks(path, () => new Date('2026-11-02T00:00:00.000Z')).set('k1', true), '2026-11-01T00:00:00.000Z')
  assert.equal(await store.set('k1', false), undefined)
  assert.equal((await new ResultChecks(path).all()).has('k1'), false)
})

test('ResultChecks: 壊れたファイル・時刻でない値は読まない。上限を超えたら古いものから捨てる', async () => {
  const path = await tmp()
  await writeFile(path, '{壊れている')
  assert.equal((await new ResultChecks(path).all()).size, 0)
  const many = Object.fromEntries(Array.from({ length: RESULT_CHECKS_MAX }, (_, i) => [`k${i}`, '2026-11-01T00:00:00.000Z']))
  await writeFile(path, JSON.stringify({ checks: { ...many, bad: 'きのう' } }))
  const store = new ResultChecks(path)
  assert.equal((await store.all()).has('bad'), false)
  await store.set('new', true)
  const now = await store.all()
  assert.equal(now.size, RESULT_CHECKS_MAX)
  assert.equal(now.has('k0'), false, '一番古いものを捨てる')
  assert.equal(now.has('new'), true)
})

test('ResultChecks: 続けて押しても片方が消えない', async () => {
  const path = await tmp()
  const store = new ResultChecks(path)
  await Promise.all([store.set('a', true), store.set('b', true), store.set('c', true)])
  assert.deepEqual([...(await new ResultChecks(path).all()).keys()].sort(), ['a', 'b', 'c'])
})
