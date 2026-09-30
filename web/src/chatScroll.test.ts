import { test } from 'node:test'
import assert from 'node:assert/strict'
import { NEAR_BOTTOM_PX, followsBottom, followsResize, nearBottom, prepended } from './chatScroll.ts'

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

test('followsResize: 追従中に見えている高さが変わったら送る。読み返している間は送らない（#544）', () => {
  // 差分ボタンが出て、入力欄の上に余白を取ったぶん箱が縮んだ（中身の高さは同じなので followsBottom は送らない）
  assert.equal(followsBottom(true, 1000, 1000), false, '前提: 中身の高さだけでは送らない')
  assert.equal(followsResize(true, 600, 568), true)
  assert.equal(followsResize(true, 568, 600), true, 'ボタンが消えて広がったときも')
  assert.equal(followsResize(true, 600, 600), false, '変わっていない')
  assert.equal(followsResize(false, 600, 568), false, '上に遡って読んでいる間は動かさない')
  assert.equal(followsResize(true, 0, 568), false, '最初の 1 回（まだ測っていない）は followsBottom に任せる')
})

test('prepended: 先頭の行がさかのぼったときだけ', () => {
  assert.equal(prepended('2026-09-18T12:00:00+09:00', '2026-09-11T09:00:00+09:00'), true)
  assert.equal(prepended('', '2026-09-11T09:00:00+09:00'), false, '最初の描画')
  assert.equal(prepended('2026-09-18T12:00:00+09:00', '2026-09-18T12:00:00+09:00'), false)
  assert.equal(prepended('2026-09-18T12:00:00+09:00', '2026-09-19T12:00:00+09:00'), false, '先頭が窓から落ちた')
  assert.equal(prepended('2026-09-18T12:00:00+09:00', ''), false)
})
