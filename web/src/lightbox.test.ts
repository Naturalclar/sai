import { test } from 'node:test'
import assert from 'node:assert/strict'
import { opensInPage, stepIndex } from './lightbox.ts'

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
