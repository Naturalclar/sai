import { test } from 'node:test'
import assert from 'node:assert/strict'
import { opensInPage, stepIndex, swipeAllowed, swipeStep, SWIPE_MIN_PX } from './lightbox.ts'

const click = { button: 0, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false }

test('stepIndex: 端で止める（回さない）', () => {
  assert.equal(stepIndex(0, 3, 1), 1)
  assert.equal(stepIndex(2, 3, 1), 2)
  assert.equal(stepIndex(0, 3, -1), 0)
  assert.equal(stepIndex(0, 0, 1), 0)
})

test('opensInPage: 普通のクリックだけ横取りする。⌘・Ctrl・Shift・Alt 付きと中クリックはブラウザに任せる', () => {
  assert.equal(opensInPage(click), true)
  for (const k of ['metaKey', 'ctrlKey', 'shiftKey', 'altKey'] as const) assert.equal(opensInPage({ ...click, [k]: true }), false, k)
  assert.equal(opensInPage({ ...click, button: 1 }), false)
})

test('swipeStep: 左へ払うと次・右へ払うと前。短い動きと縦寄りの動きでは送らない（#509）', () => {
  assert.equal(swipeStep(-SWIPE_MIN_PX, 0), 1)
  assert.equal(swipeStep(80, 10), -1)
  assert.equal(swipeStep(-(SWIPE_MIN_PX - 1), 0), 0, '足りない')
  assert.equal(swipeStep(-60, 70), 0, '縦のスクロールのつもり')
  assert.equal(swipeStep(0, 0), 0)
})

test('swipeAllowed: ピンチで拡大している間は送らない（横スクロールに任せる）', () => {
  assert.equal(swipeAllowed(1), true)
  assert.equal(swipeAllowed(undefined), true, 'visualViewport が無いブラウザ')
  assert.equal(swipeAllowed(1.5), false)
})
