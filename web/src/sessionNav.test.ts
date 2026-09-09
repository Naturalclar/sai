import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isTypingTarget, navAction, navTarget } from './sessionNav.ts'

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

const feed = { kind: 'feed' } as const
const session = (id: string) => ({ kind: 'session', id }) as const

test('navTarget: 開いているセッションを起点に隣へ。末尾の ↓ は止まる', () => {
  const ids = ['a', 'b', 'c']
  assert.deepEqual(navTarget(ids, 'b', 'next'), session('c'))
  assert.deepEqual(navTarget(ids, 'b', 'prev'), session('a'))
  assert.equal(navTarget(ids, 'c', 'next'), null, '末尾で ↓ は止まる')
})

test('navTarget: フィードはサイドバーと同じく 0 番目の項目', () => {
  const ids = ['a', 'b', 'c']
  assert.deepEqual(navTarget(ids, 'a', 'prev'), feed, '一番上のセッションで ↑ はフィードへ')
  assert.equal(navTarget(ids, null, 'prev'), null, 'フィードで ↑ は止まる（下へ動かない）')
  assert.deepEqual(navTarget(ids, null, 'next'), session('a'), 'フィードで ↓ は先頭のセッションへ')
})

test('navTarget: 一覧に無ければ先頭のセッションへ。一覧が空なら行き先なし', () => {
  const ids = ['a', 'b']
  assert.deepEqual(navTarget(ids, 'zzz', 'next'), session('a'), '絞り込みで隠れたセッションを開いているとき')
  assert.deepEqual(navTarget(ids, 'zzz', 'prev'), session('a'))
  assert.equal(navTarget([], 'a', 'next'), null)
  assert.equal(navTarget([], null, 'prev'), null)
  assert.equal(navTarget([], null, 'next'), null, '一覧が空ならフィードから下へも行けない')
})

test('navAction: → は入力欄へ', () => {
  assert.equal(navAction(key('ArrowRight')), 'input')
  assert.equal(navAction(key('ArrowRight', { metaKey: true })), null)
  assert.equal(navAction(key('ArrowRight', { shiftKey: true })), null)
  assert.equal(navAction(key('ArrowRight', { isComposing: true })), null)
  assert.equal(navAction(key('ArrowLeft')), null, '← は入力欄側（replyFocus.ts）が見る')
})
