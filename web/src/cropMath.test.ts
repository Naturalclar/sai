import { test } from 'node:test'
import assert from 'node:assert/strict'
import { clampView, coverScale, cropRect, initialView, MAX_ZOOM, zoomAt } from './cropMath.ts'

test('coverScale は枠を覆う最小の倍率（短辺が枠に合う）', () => {
  assert.equal(coverScale(400, 200, 100), 0.5, '横長: 高さ 200 → 100')
  assert.equal(coverScale(200, 400, 100), 0.5, '縦長: 幅 200 → 100')
  assert.equal(coverScale(50, 50, 100), 2, '小さい画像は拡大')
})

test('initialView は中央。横長なら左右にはみ出す', () => {
  const v = initialView(400, 200, 100)
  assert.deepEqual(v, { scale: 0.5, x: -50, y: 0 })
  assert.deepEqual(cropRect(100, v), { sx: 100, sy: 0, sw: 200, sh: 200 }, '元画像の中央 200×200')
})

test('clampView は枠の外に余白を作らず、倍率も最小〜最小×4 に収める', () => {
  // 右に動かしすぎ → x は 0 まで。下に動かしすぎ → y は frame - h まで
  assert.deepEqual(clampView(400, 200, 100, { scale: 0.5, x: 30, y: -80 }), { scale: 0.5, x: 0, y: 0 })
  assert.deepEqual(clampView(400, 200, 100, { scale: 0.5, x: -500, y: 5 }), { scale: 0.5, x: -100, y: 0 })
  assert.equal(clampView(400, 200, 100, { scale: 0.1, x: 0, y: 0 }).scale, 0.5, '縮めすぎは最小に')
  assert.equal(clampView(400, 200, 100, { scale: 99, x: 0, y: 0 }).scale, 0.5 * MAX_ZOOM)
})

test('zoomAt はカーソルの下の点を動かさない', () => {
  const v = initialView(200, 200, 100) // scale 0.5, x 0, y 0
  // 枠の (50, 50)（画像の (100, 100)）を中心に 2 倍 → 画像の (100,100) が枠の (50,50) のまま
  const z = zoomAt(200, 200, 100, v, 1, 50, 50)
  assert.equal(z.scale, 1)
  assert.deepEqual([z.x, z.y], [-50, -50])
  const r = cropRect(100, z)
  assert.deepEqual([r.sx + r.sw / 2, r.sy + r.sh / 2], [100, 100], '枠の中心は画像の (100,100) のまま')
  // 端で拡大しても枠の外に余白が出ない
  const edge = zoomAt(200, 200, 100, v, 1, 0, 0)
  assert.deepEqual([edge.x, edge.y], [0, 0])
})
