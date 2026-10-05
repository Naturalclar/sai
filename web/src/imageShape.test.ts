import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { BAND_FLOOR_HEIGHT, BAND_MIN_HEIGHT, THUMB_WIDTH, bandLayout } from './imageShape.ts'

test('bandLayout: 横に細長い画像（帯）だけ幅の上限を外す。ふつう・縦長は今までどおり（#702）', () => {
  // Codex が貼った帯。元の幅まで広げてよく、高さ 18px（幅 723px）より小さくは縮めない
  assert.deepEqual(bandLayout(1084, 27), { cap: 1084, floor: 723 })
  assert.deepEqual(bandLayout(744, 27), { cap: 744, floor: 496 })
  assert.equal(bandLayout(1200, 900), null, 'ふつうのスクリーンショット')
  assert.equal(bandLayout(1920, 1080), null)
  assert.equal(bandLayout(390, 3000), null, '縦長は高さの上限で抑えたまま')
})

test('bandLayout: 境目は「幅の上限まで縮めた高さが BAND_MIN_HEIGHT」。境目では今までと同じ大きさ（飛ばない）', () => {
  const edge = THUMB_WIDTH / BAND_MIN_HEIGHT
  assert.equal(bandLayout(edge * 300 - 1, 300), null)
  // ちょうど境目: 幅の上限は 320px のまま
  assert.equal(bandLayout(edge * 300, 300)?.cap, THUMB_WIDTH)
  // 細長くなるほど広がる（高さは BAND_MIN_HEIGHT のまま）
  assert.equal(bandLayout(1200, 200)?.cap, 6 * BAND_MIN_HEIGHT)
})

test('bandLayout: 元の大きさより大きくしない。低い画像は元の高さより縮めない', () => {
  assert.deepEqual(bandLayout(200, 20), { cap: 200, floor: 180 })
  assert.deepEqual(bandLayout(400, 10), { cap: 400, floor: 400 }, `元の高さが ${BAND_FLOOR_HEIGHT}px 未満`)
})

test('bandLayout: 大きさが分からないものは今までどおり', () => {
  assert.equal(bandLayout(0, 0), null)
  assert.equal(bandLayout(100, 0), null)
  assert.equal(bandLayout(Number.NaN, 10), null)
})

test('THUMB_WIDTH は styles.css の本文の画像の幅の上限と同じ（ずれると境目で大きさが飛ぶ）', () => {
  const css = readFileSync(new URL('./styles.css', import.meta.url), 'utf-8')
  assert.ok(css.includes(`.md-img > a:first-child { display: inline-flex; align-items: center; min-width: 44px; min-height: 44px; max-width: min(${THUMB_WIDTH}px, 100%); }`))
})
