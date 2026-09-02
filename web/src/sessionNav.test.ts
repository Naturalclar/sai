import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isTypingTarget, navAction, neighborSessionId } from './sessionNav.ts'

const key = (name: string, over: Partial<Parameters<typeof navAction>[0]> = {}) => ({
  key: name,
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  isComposing: false,
  ...over,
})

test('navAction: ↑/k が prev、↓/j が next、Esc が feed', () => {
  assert.equal(navAction(key('ArrowUp')), 'prev')
  assert.equal(navAction(key('k')), 'prev')
  assert.equal(navAction(key('ArrowDown')), 'next')
  assert.equal(navAction(key('j')), 'next')
  assert.equal(navAction(key('Escape')), 'feed')
  assert.equal(navAction(key('Enter')), null)
  assert.equal(navAction(key('J')), null, '大文字（Shift）は別のキー')
})

test('navAction: 修飾キー付きと IME 変換中は何もしない', () => {
  assert.equal(navAction(key('ArrowDown', { metaKey: true })), null)
  assert.equal(navAction(key('ArrowDown', { ctrlKey: true })), null)
  assert.equal(navAction(key('j', { altKey: true })), null)
  assert.equal(navAction(key('ArrowUp', { shiftKey: true })), null)
  assert.equal(navAction(key('ArrowDown', { isComposing: true })), null)
})

test('isTypingTarget: 入力欄と contentEditable だけ', () => {
  assert.equal(isTypingTarget({ tagName: 'TEXTAREA' }), true)
  assert.equal(isTypingTarget({ tagName: 'input' }), true)
  assert.equal(isTypingTarget({ tagName: 'SELECT' }), true)
  assert.equal(isTypingTarget({ tagName: 'DIV', isContentEditable: true }), true)
  assert.equal(isTypingTarget({ tagName: 'BUTTON' }), false)
  assert.equal(isTypingTarget({ tagName: 'A' }), false)
  assert.equal(isTypingTarget({}), false, 'window など tagName が無いもの')
  assert.equal(isTypingTarget(null), false)
})

test('neighborSessionId: 開いているセッションを起点に隣へ、端では止まる', () => {
  const ids = ['a', 'b', 'c']
  assert.equal(neighborSessionId(ids, 'b', 'next'), 'c')
  assert.equal(neighborSessionId(ids, 'b', 'prev'), 'a')
  assert.equal(neighborSessionId(ids, 'c', 'next'), null, '末尾で ↓')
  assert.equal(neighborSessionId(ids, 'a', 'prev'), null, '先頭で ↑')
})

test('neighborSessionId: 一覧に無ければ先頭から。一覧が空なら null', () => {
  const ids = ['a', 'b']
  assert.equal(neighborSessionId(ids, null, 'next'), 'a', 'フィードを見ているとき')
  assert.equal(neighborSessionId(ids, null, 'prev'), 'a')
  assert.equal(neighborSessionId(ids, 'zzz', 'next'), 'a', '絞り込みで隠れたセッションを開いているとき')
  assert.equal(neighborSessionId([], 'a', 'next'), null)
  assert.equal(neighborSessionId([], null, 'prev'), null)
})
