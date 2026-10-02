import { test } from 'node:test'
import assert from 'node:assert/strict'
import { approvalAction, hotkeyApplies } from './approvalKeys.ts'

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

test('hotkeyApplies: モーダルの中・フォーカスの無いペインの中で押した ⌘Enter は許可に使わない（#633）', () => {
  assert.equal(hotkeyApplies(null, 'a@repo', true), false)
  assert.equal(hotkeyApplies('a@repo', 'a@repo', true), false)
  assert.equal(hotkeyApplies(null, 'a@repo', false), true)
})

test('hotkeyApplies: 別のセッションの返信欄で押した ⌘Enter は許可に使わない（要対応の行の下の返信欄）', () => {
  // 印の無い場所（セッション画面の入力欄・本文）は今までどおり
  assert.equal(hotkeyApplies(null, 'a@repo'), true)
  // 同じセッションの返信欄
  assert.equal(hotkeyApplies('a@repo', 'a@repo'), true)
  // 別のセッションの返信欄では、その返信欄の送信に任せる
  assert.equal(hotkeyApplies('b@repo', 'a@repo'), false)
})
