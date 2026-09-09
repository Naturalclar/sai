import { test } from 'node:test'
import assert from 'node:assert/strict'
import { approvalAction } from './approvalKeys.ts'

const key = (over: Partial<Parameters<typeof approvalAction>[0]> = {}) => ({
  key: 'Enter',
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  isComposing: false,
  ...over,
})

test('approvalAction: ⌘Enter で許可、⌘⇧Enter で常に許可', () => {
  assert.equal(approvalAction(key({ metaKey: true }), true), 'allow')
  assert.equal(approvalAction(key({ metaKey: true, shiftKey: true }), true), 'always')
})

test('approvalAction: Windows / Linux の Ctrl+Enter も同じ', () => {
  assert.equal(approvalAction(key({ ctrlKey: true }), true), 'allow')
  assert.equal(approvalAction(key({ ctrlKey: true, shiftKey: true }), true), 'always')
})

test('approvalAction: 「常に許可」が無いバブルでは ⌘⇧Enter も許可に落ちる', () => {
  assert.equal(approvalAction(key({ metaKey: true, shiftKey: true }), false), 'allow')
  assert.equal(approvalAction(key({ metaKey: true }), false), 'allow')
})

test('approvalAction: 素の Enter は触らない（入力欄の送信）', () => {
  assert.equal(approvalAction(key(), true), null)
  assert.equal(approvalAction(key({ shiftKey: true }), true), null, '⇧Enter は改行')
})

test('approvalAction: IME 変換中・Alt 付き・Enter 以外は何もしない', () => {
  assert.equal(approvalAction(key({ metaKey: true, isComposing: true }), true), null)
  assert.equal(approvalAction(key({ metaKey: true, altKey: true }), true), null)
  assert.equal(approvalAction(key({ metaKey: true, shiftKey: true, altKey: true }), true), null)
  assert.equal(approvalAction(key({ key: 'a', metaKey: true }), true), null)
  assert.equal(approvalAction(key({ key: 'Escape', metaKey: true }), true), null)
})
