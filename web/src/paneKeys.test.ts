import { test } from 'node:test'
import assert from 'node:assert/strict'
import { paneKey } from './paneKeys.ts'

const key = (k: string, over: Partial<Parameters<typeof paneKey>[0]> = {}) => ({ key: k, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, isComposing: false, ...over })

test('paneKey: % で分ける（Shift を伴う配列でも）、h / l で移る、x で閉じる', () => {
  assert.deepEqual(paneKey(key('%', { shiftKey: true }), false), { kind: 'split' })
  assert.deepEqual(paneKey(key('%'), false), { kind: 'split' })
  assert.deepEqual(paneKey(key('h'), false), { kind: 'move', by: -1 })
  assert.deepEqual(paneKey(key('l'), false), { kind: 'move', by: 1 })
  assert.deepEqual(paneKey(key('x'), false), { kind: 'close' })
})

test('paneKey: 入力欄で打っている間は % h l x を受けない（文字として入る）', () => {
  for (const k of ['%', 'h', 'l', 'x']) assert.equal(paneKey(key(k), true), null, k)
})

test('paneKey: 修飾キー付きの h l x と IME 変換中は何もしない（⌘L・Ctrl+H をブラウザに残す）', () => {
  assert.equal(paneKey(key('l', { metaKey: true }), false), null)
  assert.equal(paneKey(key('h', { ctrlKey: true }), false), null)
  assert.equal(paneKey(key('x', { altKey: true }), false), null)
  assert.equal(paneKey(key('H', { shiftKey: true }), false), null)
  assert.equal(paneKey(key('%', { metaKey: true, shiftKey: true }), false), null)
  assert.equal(paneKey(key('x', { isComposing: true }), false), null)
  assert.equal(paneKey(key('1', { ctrlKey: true, isComposing: true }), true), null)
})

test('paneKey: Ctrl+1〜3 は入力中でも効き、左から数えたペインを指す', () => {
  assert.deepEqual(paneKey(key('1', { ctrlKey: true }), true), { kind: 'focus', index: 0 })
  assert.deepEqual(paneKey(key('3', { ctrlKey: true }), false), { kind: 'focus', index: 2 })
})

test('paneKey: 上限より先の番号・⌘+数字（タブの切り替え）・素の数字は受けない', () => {
  assert.equal(paneKey(key('4', { ctrlKey: true }), false), null)
  assert.equal(paneKey(key('1', { metaKey: true }), false), null)
  assert.equal(paneKey(key('1', { ctrlKey: true, metaKey: true }), false), null)
  assert.equal(paneKey(key('1', { ctrlKey: true, shiftKey: true }), false), null)
  assert.equal(paneKey(key('1'), false), null)
})
