import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fetchByRev, RevCache } from './revCache.ts'

test('fetchByRev: 2 回目は If-None-Match を付け、304 なら覚えた本文をそのまま返す（#592）', async () => {
  const cache = new RevCache()
  const asked: (string | undefined)[] = []
  let rev = 'r1'
  const fake = async (_url: string, init: { headers?: Record<string, string> }) => {
    asked.push(init.headers?.['If-None-Match'])
    if (init.headers?.['If-None-Match'] === `"${rev}"`) return new Response(null, { status: 304 })
    return new Response(JSON.stringify({ rev }), { status: 200, headers: { ETag: `"${rev}"` } })
  }
  const first = await fetchByRev(cache, '/api/sessions?days=7', fake)
  assert.deepEqual(first.data, { rev: 'r1' })
  const second = await fetchByRev(cache, '/api/sessions?days=7', fake)
  assert.equal(second.res.status, 304)
  assert.equal(second.data, first.data, '同じオブジェクト（usePolling が rev で描き直しを止める）')
  assert.deepEqual(asked, [undefined, '"r1"'])
  // 変わったら 200 で新しい本文
  rev = 'r2'
  assert.deepEqual((await fetchByRev(cache, '/api/sessions?days=7', fake)).data, { rev: 'r2' })
  // 別の URL には前の ETag を付けない
  await fetchByRev(cache, '/api/sessions?days=30', fake)
  assert.equal(asked.at(-1), undefined)
})

test('fetchByRev: 失敗は覚えず、そのまま返す。ETag の無い応答も覚えない', async () => {
  const cache = new RevCache()
  const failed = await fetchByRev(cache, '/x', async () => new Response('{"error":"no"}', { status: 404 }))
  assert.equal(failed.res.status, 404)
  assert.equal(failed.data, undefined)
  await fetchByRev(cache, '/y', async () => new Response('{"rev":"a"}', { status: 200 }))
  assert.equal(cache.get('/y'), undefined)
})

test('RevCache: 古いものから落とす。使ったものは残る', () => {
  const cache = new RevCache(2)
  cache.set('a', '"1"', 1)
  cache.set('b', '"2"', 2)
  cache.get('a')
  cache.set('c', '"3"', 3)
  assert.equal(cache.get('b'), undefined)
  assert.equal(cache.get('a')?.data, 1)
  assert.equal(cache.get('c')?.data, 3)
})
