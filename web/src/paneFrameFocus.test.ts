import { test } from 'node:test'
import assert from 'node:assert/strict'
import { frameFocusedIn } from './paneFrameFocus.ts'

const root = (inside: object[]) => ({ contains: (n: object) => inside.includes(n) })

test('frameFocusedIn: このペインの中の枠にフォーカスが入ったときだけ true（#897）', () => {
  const frame = { tagName: 'IFRAME' }
  const other = { tagName: 'IFRAME' }
  const body = { tagName: 'BODY' }
  const input = { tagName: 'TEXTAREA' }
  assert.equal(frameFocusedIn(frame, root([frame])), true)
  assert.equal(frameFocusedIn(other, root([frame])), false, 'ほかのペインの枠')
  assert.equal(frameFocusedIn(body, root([body])), false, 'アプリを切り替えた（activeElement が body）')
  assert.equal(frameFocusedIn(input, root([input])), false, '枠でない要素（それは onFocusCapture が拾う）')
  assert.equal(frameFocusedIn(null, root([frame])), false)
  assert.equal(frameFocusedIn(frame, null), false, 'ペインがもう無い')
})
