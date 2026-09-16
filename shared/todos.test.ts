// #397。実機（OpenCode 1.18.30）の応答をそのまま置く
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { opencodeTodos, todoCounts, todoNow } from './todos.ts'

// `GET /session/<id>/todo` が実際に返したもの。**`id` は無い**
const real = [
  { content: '調べる', status: 'completed', priority: 'medium' },
  { content: '直す', status: 'in_progress', priority: 'medium' },
  { content: '確かめる', status: 'pending', priority: 'medium' },
]

test('opencodeTodos: 出てきた順のまま読む。読めなければ空', () => {
  assert.deepEqual(opencodeTodos(real), real)
  assert.deepEqual(opencodeTodos([]), [], '段取りが無いセッション（実測では 16 件すべてこれだった）')
  assert.deepEqual(opencodeTodos(null), [])
  assert.deepEqual(opencodeTodos({ todos: real }), [], '配列以外は読まない')
  // 中身が足りない要素は落とす（content が本体）
  assert.deepEqual(opencodeTodos([{ status: 'pending' }, 'x', null, { content: '  ' }]), [])
  assert.deepEqual(opencodeTodos([{ content: ' 直す ' }]), [{ content: '直す', status: '', priority: '' }], '前後の空白は詰める')
})

test('todoCounts: 済み / 全体。cancelled はどちらにも数えない', () => {
  assert.deepEqual(todoCounts(opencodeTodos(real)), { done: 1, total: 3 })
  assert.deepEqual(todoCounts([]), { done: 0, total: 0 })
  const dropped = [...real, { content: 'やめた', status: 'cancelled', priority: 'low' }]
  assert.deepEqual(todoCounts(dropped), { done: 1, total: 3 }, 'やめたものは分母から外す')
  assert.deepEqual(todoCounts([{ content: 'a', status: 'completed', priority: 'low' }]), { done: 1, total: 1 })
})

test('todoNow: いま動かしているもの → 無ければ最初の未着手', () => {
  assert.equal(todoNow(real)?.content, '直す')
  assert.equal(todoNow([{ content: 'a', status: 'pending', priority: 'low' }, { content: 'b', status: 'pending', priority: 'low' }])?.content, 'a')
  assert.equal(todoNow([{ content: 'a', status: 'completed', priority: 'low' }]), null, '全部済みなら無い')
  assert.equal(todoNow([]), null)
})
