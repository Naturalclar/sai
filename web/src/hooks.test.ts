import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseRoute, sessionHash } from './hooks.ts'

test('parseRoute: 画面の振り分け', () => {
  assert.deepEqual(parseRoute('#/feed'), { name: 'feed' })
  assert.deepEqual(parseRoute('#/todo'), { name: 'todo' })
  assert.deepEqual(parseRoute('#/'), { name: 'list' })
  assert.deepEqual(parseRoute(''), { name: 'list' })
  assert.deepEqual(parseRoute('#/s/S1%40sai'), { name: 'session', id: 'S1@sai' })
})

test('parseRoute: 検索から飛んできた ts を取る（#230）', () => {
  assert.deepEqual(parseRoute('#/s/S1%40sai?ts=2026-09-09T23%3A14%3A42%2B09%3A00'), {
    name: 'session',
    id: 'S1@sai',
    ts: '2026-09-09T23:14:42+09:00',
  })
  // ts が無ければキーごと付けない（普通のセッションと同じ形）
  assert.deepEqual(parseRoute('#/s/S1%40sai'), { name: 'session', id: 'S1@sai' })
  assert.deepEqual(parseRoute('#/s/S1%40sai?ts='), { name: 'session', id: 'S1@sai' }, '空の ts は無いのと同じ')
  assert.deepEqual(parseRoute('#/s/S1%40sai?x=1'), { name: 'session', id: 'S1@sai' }, '知らないキーは見ない')
})

test('parseRoute: id は encodeURIComponent 済みなので ? を含まない（%3F になる）', () => {
  // 生の `?` を含む id は作られないが、来ても id 側を壊さない
  assert.deepEqual(parseRoute('#/s/a%3Fb%40sai'), { name: 'session', id: 'a?b@sai' })
})

test('parseRoute: 壊れた %-エンコードでも落ちない', () => {
  const r = parseRoute('#/s/%E0%A4%A')
  assert.equal(r.name, 'session')
  assert.equal(r.name === 'session' && r.id, '%E0%A4%A', 'そのままにして「無いセッション」に落とす')
})

test('sessionHash: parseRoute と往復する', () => {
  const id = 'S1@sai'
  const ts = '2026-09-09T23:14:42+09:00'
  assert.deepEqual(parseRoute(sessionHash(id, ts)), { name: 'session', id, ts })
  assert.deepEqual(parseRoute(sessionHash(id)), { name: 'session', id })
  // `+` や `:` を含む ts が生で入らない（`+` は空白に化ける）
  assert.ok(!sessionHash(id, ts).includes('+'))
})
