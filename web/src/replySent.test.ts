import { test } from 'node:test'
import assert from 'node:assert/strict'
import { clearsOnSent } from './replySent.ts'

test('clearsOnSent: 確認から送り直して受け付けられた数が増えたときだけ入力欄を空にする（#338）', () => {
  assert.equal(clearsOnSent(0, 1), true, '1 回目の送り直し')
  assert.equal(clearsOnSent(1, 2), true, '2 回目')
  assert.equal(clearsOnSent(0, 0), false, 'まだ一度も送り直していない（毎描画で空にしない）')
  assert.equal(clearsOnSent(2, 2), false, '同じ数の描画では空にしない（そのあと打ち始めた本文を消さない）')
  assert.equal(clearsOnSent(2, 1), false, '減ることは無いが、減ったら何もしない')
})
