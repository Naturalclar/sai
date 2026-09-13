import { test } from 'node:test'
import assert from 'node:assert/strict'
import { NEAR_BOTTOM_PX, followsBottom, nearBottom } from './chatScroll.ts'

test('nearBottom は最下部までの距離が NEAR_BOTTOM_PX 未満のときだけ真', () => {
  // scrollHeight 1000, clientHeight 500 → 最下部は scrollTop 500
  assert.equal(nearBottom(1000, 500, 500), true) // ぴったり最下部
  assert.equal(nearBottom(1000, 500 - (NEAR_BOTTOM_PX - 1), 500), true) // 39px 上
  assert.equal(nearBottom(1000, 500 - NEAR_BOTTOM_PX, 500), false) // 40px 上
  assert.equal(nearBottom(1000, 500 - (NEAR_BOTTOM_PX + 1), 500), false) // 41px 上
  assert.equal(nearBottom(1000, 0, 500), false)
  // 中身が画面に収まっていれば常に最下部
  assert.equal(nearBottom(400, 0, 500), true)
})

test('followsBottom は追従中で高さが変わったときだけ真', () => {
  assert.equal(followsBottom(true, 0, 1000), true) // 最初の描画（まだ送っていない）
  assert.equal(followsBottom(true, 1000, 1200), true) // 行が増えた
  assert.equal(followsBottom(true, 1200, 1000), true) // 一言が届いて縮んだ
  assert.equal(followsBottom(true, 1000, 1000), false) // 中身が変わっていない（3 秒ごとの描き直し）
  assert.equal(followsBottom(false, 1000, 1200), false) // 上に遡っている間は追従しない
  assert.equal(followsBottom(false, 1000, 1000), false)
})
