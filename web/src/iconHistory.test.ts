import { test } from 'node:test'
import assert from 'node:assert/strict'
import { nextRemoval } from './iconHistory.ts'

test('nextRemoval: 同じものを 2 回押したときだけ消す（#465）', () => {
  assert.deepEqual(nextRemoval(null, 'a'), { confirming: 'a', remove: false })
  assert.deepEqual(nextRemoval('a', 'a'), { confirming: null, remove: true })
  assert.deepEqual(nextRemoval('a', 'b'), { confirming: 'b', remove: false }, '別のものは、そちらの 1 回目')
})
