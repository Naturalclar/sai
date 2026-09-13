import { test } from 'node:test'
import assert from 'node:assert/strict'
import { restoresImages, restoresOnRequest, restoresText } from './replyRestore.ts'

test('restoresText は入力欄が空のときだけ戻す', () => {
  assert.equal(restoresText(''), true)
  assert.equal(restoresText('   \n '), true) // 空白だけなら打ちかけとは見ない
  assert.equal(restoresText('もう次を打ち始めている'), false)
  assert.equal(restoresText('a'), false)
})

test('restoresImages は画像が 1 枚も無いときだけ戻す', () => {
  assert.equal(restoresImages(0), true)
  assert.equal(restoresImages(1), false)
  assert.equal(restoresImages(3), false)
})

test('restoresOnRequest は seq が増えたときだけ', () => {
  assert.equal(restoresOnRequest(0, 1), true)
  assert.equal(restoresOnRequest(1, 2), true)
  assert.equal(restoresOnRequest(0, 0), false)
  assert.equal(restoresOnRequest(2, 2), false)
  assert.equal(restoresOnRequest(2, 1), false)
})
