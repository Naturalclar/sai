import { test } from 'node:test'
import assert from 'node:assert/strict'
import { openRow, rowReplyable } from './todoReply.ts'
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

test('openRow: 開いていた行が並びから消えたら閉じる（戻ってきても勝手に開かない）', () => {
  const items = [item('a', 'done'), item('b', 'watch')]
  assert.equal(openRow('a', items), 'a')
  assert.equal(openRow(null, items), null)
  // 送って処理中になった → 並びから消える
  assert.equal(openRow('c', items), null)
  // 行は残っているが、もう打てない（別のマシンの行に変わった等）
  assert.equal(openRow('a', [item('a', 'done', false)]), null)
})
