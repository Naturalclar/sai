import { test } from 'node:test'
import assert from 'node:assert/strict'
import { collapseScrollBy } from './diffSticky.ts'

test('collapseScrollBy: 見出しが貼り付いている（箱の上端が見えている範囲より上）なら、箱の先頭まで戻す', () => {
  assert.equal(collapseScrollBy(-840, 0), -840)
  // スクロール容器が画面の途中から始まる（ペイン・モーダル）ときは、その上端から測る
  assert.equal(collapseScrollBy(-300.4, 120), -420)
})

test('collapseScrollBy: 見出しが元の位置にあるときは動かさない', () => {
  assert.equal(collapseScrollBy(200, 120), 0)
  assert.equal(collapseScrollBy(120, 120), 0)
  // 端数のずれ（0.4px 上）では動かさない
  assert.equal(collapseScrollBy(119.6, 120), 0)
})
