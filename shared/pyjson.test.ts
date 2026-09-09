import { test } from 'node:test'
import assert from 'node:assert/strict'
import { dumpsLikePython } from './pyjson.ts'

// 期待文字列はすべて `python3 -c "import json; print(json.dumps(X, ensure_ascii=False, sort_keys=True))"`
// の出力そのもの。片方を変えたらここが落ちる

test('dumpsLikePython: 区切りは ", " と ": "（JSON.stringify は詰める）', () => {
  assert.equal(dumpsLikePython({ a: 1, b: 2 }), '{"a": 1, "b": 2}')
  assert.equal(dumpsLikePython([1, 2, 3]), '[1, 2, 3]')
})

test('dumpsLikePython: キーはソート。入れ子の中も', () => {
  assert.equal(dumpsLikePython({ title: '題', body: '本文' }), '{"body": "本文", "title": "題"}')
  assert.equal(dumpsLikePython({ zebra: 1, apple: 2 }), '{"apple": 2, "zebra": 1}')
  assert.equal(dumpsLikePython({ b: { y: 2, x: 1 }, a: [1, { q: '日本語' }] }), '{"a": [1, {"q": "日本語"}], "b": {"x": 1, "y": 2}}')
})

test('dumpsLikePython: 非 ASCII はそのまま（ensure_ascii=False）', () => {
  assert.equal(dumpsLikePython({ q: '日本語' }), '{"q": "日本語"}')
  assert.equal(dumpsLikePython('🎉'), '"🎉"')
})

test('dumpsLikePython: 文字列のエスケープは JSON.stringify と同じで足りる', () => {
  assert.equal(dumpsLikePython({ s: 'a"b\\c\nd\te' }), '{"s": "a\\"b\\\\c\\nd\\te"}')
  // 制御文字は \u00XX。Python も同じ形
  assert.equal(dumpsLikePython('\u0001'), '"\\u0001"')
})

test('dumpsLikePython: スカラーと空の入れ物', () => {
  assert.equal(dumpsLikePython(null), 'null')
  assert.equal(dumpsLikePython(true), 'true')
  assert.equal(dumpsLikePython(1.5), '1.5')
  assert.equal(dumpsLikePython({}), '{}')
  assert.equal(dumpsLikePython([]), '[]')
  assert.equal(dumpsLikePython({ a: {}, b: [] }), '{"a": {}, "b": []}')
})

test('dumpsLikePython: キーの並びはコードポイント順（JS の < は UTF-16 の符号単位順）', () => {
  // 🎉 は U+1F389。UTF-16 では 🎉 になるので、素朴な `<` だと U+FF21（Ａ）より前に来てしまう。
  // Python はコードポイントで比べるので 🎉 が後ろ
  assert.equal(dumpsLikePython({ '🎉': 1, Ａ: 2 }), '{"Ａ": 2, "🎉": 1}')
})

test('dumpsLikePython: undefined は落とす（Python 側に無いので、落ちないためだけの扱い）', () => {
  assert.equal(dumpsLikePython({ a: 1, b: undefined }), '{"a": 1}')
  assert.equal(dumpsLikePython([1, undefined]), '[1, null]')
})
