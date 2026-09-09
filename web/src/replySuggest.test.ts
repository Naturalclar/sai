import { test } from 'node:test'
import assert from 'node:assert/strict'
import { acceptsSuggestion, suggestFrom } from './replySuggest.ts'

const history = ['マージして', 'マージしてリリースして', 'テストを足して']

test('suggestFrom: 打った文で始まる一番新しい履歴の続きを返す', () => {
  assert.equal(suggestFrom(history, 'マ'), 'ージして', '新しい順の先頭が勝つ')
  assert.equal(suggestFrom(history, 'マージして'), 'リリースして', '完全一致は飛ばし、より長いものを出す')
  assert.equal(suggestFrom(history, 'テスト'), 'を足して')
})

test('suggestFrom: 当たりが無ければ空。本文が空でも出さない', () => {
  assert.equal(suggestFrom(history, 'ぜんぜん違う'), '')
  assert.equal(suggestFrom(history, ''), '', '空では出さない（fish と同じ）')
  assert.equal(suggestFrom([], 'マ'), '')
  assert.equal(suggestFrom(['マージして'], 'マージして'), '', '足すものが無ければ空')
})

const key = (over: Partial<Parameters<typeof acceptsSuggestion>[0]> = {}) => ({
  key: 'ArrowRight',
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  isComposing: false,
  ...over,
})
const state = (over: Partial<Parameters<typeof acceptsSuggestion>[1]> = {}) => ({
  caret: 3,
  length: 3,
  menuOpen: false,
  suggestion: 'ージして',
  ...over,
})

test('acceptsSuggestion: カーソルが末尾で続きがあるときだけ受け入れる', () => {
  assert.equal(acceptsSuggestion(key(), state()), true)
  assert.equal(acceptsSuggestion(key(), state({ caret: 1 })), false, '文の途中はカーソル移動')
  assert.equal(acceptsSuggestion(key(), state({ suggestion: '' })), false, '続きが無い')
  assert.equal(acceptsSuggestion(key(), state({ menuOpen: true })), false, '候補メニューが開いていれば触らない')
})

test('acceptsSuggestion: → 以外・修飾キー付き・IME 変換中は何もしない', () => {
  assert.equal(acceptsSuggestion(key({ key: 'ArrowLeft' }), state()), false)
  assert.equal(acceptsSuggestion(key({ key: 'Tab' }), state()), false, 'Tab は候補メニューが使う')
  assert.equal(acceptsSuggestion(key({ metaKey: true }), state()), false, '⌘→ は行末へ')
  assert.equal(acceptsSuggestion(key({ shiftKey: true }), state()), false, '⇧→ は選択')
  assert.equal(acceptsSuggestion(key({ altKey: true }), state()), false)
  assert.equal(acceptsSuggestion(key({ ctrlKey: true }), state()), false)
  assert.equal(acceptsSuggestion(key({ isComposing: true }), state()), false)
})
