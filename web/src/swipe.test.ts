import { test } from 'node:test'
import assert from 'node:assert/strict'
import { clampOffset, COMMIT_RATIO, isHorizontal, RAIL_WIDTH, swipeState, SWIPE_DEAD } from './swipe.ts'

test('swipeState: 少しなら閉じたまま、レールの幅の手前で開き、幅の 45% を超えれば実行', () => {
  const width = 320
  assert.equal(swipeState(0, width), 'closed')
  assert.equal(swipeState(-(SWIPE_DEAD - 1), width), 'closed')
  assert.equal(swipeState(-SWIPE_DEAD, width), 'open')
  assert.equal(swipeState(-RAIL_WIDTH, width), 'open')
  assert.equal(swipeState(-(width * COMMIT_RATIO), width), 'open', 'ちょうどでは実行しない')
  assert.equal(swipeState(-(width * COMMIT_RATIO + 1), width), 'commit')
  assert.equal(swipeState(-width, width), 'commit')
  assert.equal(swipeState(60, width), 'closed', '右へ動かしても開かない')
  assert.equal(swipeState(-200, 0), 'open', '幅が分からなければ実行はしない（開くだけ）')
})

test('clampOffset: 右へは 0、左は幅まで', () => {
  assert.equal(clampOffset(30, 320), 0)
  assert.equal(clampOffset(-30, 320), -30)
  assert.equal(clampOffset(-500, 320), -320)
  assert.equal(clampOffset(-500, 0), -500, '幅が分からなければそのまま')
})

test('isHorizontal: 8px 動くまでは決めない。横が大きければ横、縦が大きければ縦', () => {
  assert.equal(isHorizontal(3, 2), null)
  assert.equal(isHorizontal(-7, 7), null)
  assert.equal(isHorizontal(-12, 4), true)
  assert.equal(isHorizontal(-4, 12), false)
  assert.equal(isHorizontal(-10, 10), false, '同じなら縦（スクロールを優先）')
})
