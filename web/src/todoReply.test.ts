import { test } from 'node:test'
import assert from 'node:assert/strict'
import { opensByDefault, ownReplying, pruneToggled, rowOpen, rowReplyable, toggleKey } from './todoReply.ts'
import type { TodoItem } from '../../shared/todoItems.ts'

const session = {} as NonNullable<TodoItem['session']>
const item = (id: string, kind: TodoItem['kind'], replyable = true): Pick<TodoItem, 'id' | 'kind' | 'replyable' | 'session'> => ({ id, kind, replyable, session })

test('rowReplyable: 終わった行と返信欄から打てる待ちには出し、答え待ち・打てないものには出さない', () => {
  assert.equal(rowReplyable(item('a', 'done')), true)
  assert.equal(rowReplyable(item('a', 'watch')), true)
  // 答え待ちは行の中のボタンで答える
  assert.equal(rowReplyable(item('a', 'answer')), false)
  // 別のマシン・合成 ID・OpenCode の許可待ち
  assert.equal(rowReplyable(item('a', 'done', false)), false)
  assert.equal(rowReplyable({ ...item('a', 'done'), session: null }), false)
})

test('rowOpen: 終わった行は最初から開き、待機中は押したときだけ。切り替えた行は逆になる', () => {
  const none = new Set<string>()
  assert.equal(opensByDefault({ kind: 'done' }), true)
  assert.equal(rowOpen(item('a', 'done'), none), true)
  assert.equal(rowOpen(item('a', 'watch'), none), false)
  // 閉じた終わった行・開いた待機中
  assert.equal(rowOpen(item('a', 'done'), new Set([toggleKey(item('a', 'done'))])), false)
  assert.equal(rowOpen(item('a', 'watch'), new Set([toggleKey(item('a', 'watch'))])), true)
  // 打てない行は既定でも開かない
  assert.equal(rowOpen(item('a', 'done', false), none), false)
  assert.equal(rowOpen(item('a', 'answer'), none), false)
})

test('pruneToggled: 並びから消えた行・区分が変わった行の切り替えを忘れ、変わらなければ同じ Set を返す', () => {
  const items = [item('a', 'done'), item('b', 'watch')]
  const toggled = new Set(['done:a', 'watch:b'])
  assert.equal(pruneToggled(toggled, items), toggled)
  const empty = new Set<string>()
  assert.equal(pruneToggled(empty, items), empty)
  // b は送って処理中になり、並びから消えた
  assert.deepEqual([...pruneToggled(toggled, [item('a', 'done')])], ['done:a'])
  // a は待機中に変わった（閉じた印を持ち越さない）
  assert.deepEqual([...pruneToggled(new Set(['done:a']), [item('a', 'watch')])], [])
})

test('ownReplying: この画面から送ったセッションの返信だけを残す（ほかから送った失敗を拾わない）', () => {
  const replying = { a: { failed: true }, b: { failed: false }, c: { failed: true } }
  assert.deepEqual(ownReplying(replying, new Set(['b'])), { b: { failed: false } })
  // 送ったが、もうサーバに無い（終わった）
  assert.deepEqual(ownReplying(replying, new Set(['x'])), {})
  assert.deepEqual(ownReplying(replying, new Set()), {})
})
