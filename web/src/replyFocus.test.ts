import { test } from 'node:test'
import assert from 'node:assert/strict'
import { blursOnEscape, leavesToSidebar } from './replyFocus.ts'

const key = (over: Partial<Parameters<typeof leavesToSidebar>[0]> = {}) => ({
  key: 'ArrowLeft',
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  isComposing: false,
  ...over,
})
const state = (over: Partial<Parameters<typeof leavesToSidebar>[1]> = {}) => ({ text: '', menuOpen: false, ...over })

test('leavesToSidebar: 本文が空で候補メニューが閉じているときだけ戻る', () => {
  assert.equal(leavesToSidebar(key(), state()), true)
  assert.equal(leavesToSidebar(key(), state({ text: 'a' })), false, '書きかけならカーソル移動')
  assert.equal(leavesToSidebar(key(), state({ text: ' ' })), false, '空白も本文（カーソルを動かせる）')
  assert.equal(leavesToSidebar(key(), state({ menuOpen: true })), false, '候補メニューが開いていれば触らない')
})

test('leavesToSidebar: ← 以外・修飾キー付き・IME 変換中は何もしない', () => {
  assert.equal(leavesToSidebar(key({ key: 'ArrowRight' }), state()), false)
  assert.equal(leavesToSidebar(key({ key: 'a' }), state()), false)
  assert.equal(leavesToSidebar(key({ metaKey: true }), state()), false, '⌘← は行頭へ')
  assert.equal(leavesToSidebar(key({ shiftKey: true }), state()), false, '⇧← は選択')
  assert.equal(leavesToSidebar(key({ altKey: true }), state()), false)
  assert.equal(leavesToSidebar(key({ ctrlKey: true }), state()), false)
  assert.equal(leavesToSidebar(key({ isComposing: true }), state()), false)
})

test('blursOnEscape: 候補メニューが閉じていれば、本文があっても Esc で外れる（#904）', () => {
  const esc = key({ key: 'Escape' })
  assert.equal(blursOnEscape(esc, { menuOpen: false }), true)
  assert.equal(blursOnEscape(esc, { menuOpen: true }), false, 'メニューが開いていればメニューを閉じるだけ')
})

test('blursOnEscape: Esc 以外・修飾キー付き・IME 変換中は何もしない', () => {
  const closed = { menuOpen: false }
  assert.equal(blursOnEscape(key({ key: 'ArrowLeft' }), closed), false)
  assert.equal(blursOnEscape(key({ key: 'Escape', isComposing: true }), closed), false, '変換の取り消しは IME に任せる')
  assert.equal(blursOnEscape(key({ key: 'Escape', metaKey: true }), closed), false)
  assert.equal(blursOnEscape(key({ key: 'Escape', ctrlKey: true }), closed), false)
  assert.equal(blursOnEscape(key({ key: 'Escape', altKey: true }), closed), false)
  assert.equal(blursOnEscape(key({ key: 'Escape', shiftKey: true }), closed), false)
})
