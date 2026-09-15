import { test } from 'node:test'
import assert from 'node:assert/strict'
import { settledByRow } from './turnSettled.ts'

test('送ったあとに届いたターン完了の行なら終わり', () => {
  assert.equal(settledByRow('2026-09-15T07:48:54.553Z', '2026-09-15T16:49:31+09:00'), true) // 37 秒後
  assert.equal(settledByRow('2026-09-15T07:48:54.553Z', '2026-09-15T16:48:00+09:00'), false) // 前のターン
})

test('行の ts は秒までなので、since を秒に丸めて比べる', () => {
  // 07:48:54.553Z に送って、同じ秒（.000）に記録された行。丸めないと「前」になってしまう
  assert.equal(settledByRow('2026-09-15T07:48:54.553Z', '2026-09-15T07:48:54Z'), true)
  assert.equal(settledByRow('2026-09-15T07:48:54.553Z', '2026-09-15T07:48:53Z'), false)
})

test('行が無い・壊れているときは終わりにしない', () => {
  assert.equal(settledByRow('2026-09-15T07:48:54.553Z', undefined), false)
  assert.equal(settledByRow('2026-09-15T07:48:54.553Z', ''), false)
  assert.equal(settledByRow('2026-09-15T07:48:54.553Z', 'ごみ'), false)
  assert.equal(settledByRow('ごみ', '2026-09-15T16:49:31+09:00'), false)
})
