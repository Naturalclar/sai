import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EMOJI, EMOJI_NAME, emojiQuery, filterEmoji, lookupEmoji } from './emoji.ts'

test('EMOJI: 名前はどれも `:` の内側に来られる形。重複した名前は無い', () => {
  const names = Object.keys(EMOJI)
  assert.ok(names.length > 100, `表が小さすぎる: ${names.length}`)
  assert.deepEqual(names.filter((n) => !EMOJI_NAME.test(n)), [], '小文字・数字・_ + - だけ')
  assert.deepEqual(Object.values(EMOJI).filter((c) => !c), [], '空の絵文字は無い')
})

test('lookupEmoji: 表にある名前だけ引ける', () => {
  assert.equal(lookupEmoji('tada'), '🎉')
  assert.equal(lookupEmoji('+1'), '👍')
  assert.equal(lookupEmoji('100'), '💯')
  assert.equal(lookupEmoji('nope'), undefined)
  assert.equal(lookupEmoji(''), undefined)
  assert.equal(lookupEmoji('constructor'), undefined, 'Object の生えているものを拾わない')
  assert.equal(lookupEmoji('toString'), undefined)
})

test('emojiQuery: caret の前の最後の `:` から。2 文字以上で、名前の形のときだけ', () => {
  assert.deepEqual(emojiQuery(':tada', 5), { start: 0, query: 'tada' })
  assert.deepEqual(emojiQuery('やった:ta', 6), { start: 3, query: 'ta' }, '日本語の直後（空白なし）でも開く')
  assert.deepEqual(emojiQuery('a :ro', 5), { start: 2, query: 'ro' })
  assert.deepEqual(emojiQuery(':+1', 3), { start: 0, query: '+1' })
  assert.equal(emojiQuery(':t', 2), null, '1 文字では開かない')
  assert.equal(emojiQuery(':', 1), null)
  assert.equal(emojiQuery('ta', 2), null, '`:` が無い')
  assert.equal(emojiQuery(':ta da', 6), null, '空白が入ったらもう候補ではない')
  assert.equal(emojiQuery(':Ta', 3), null, '大文字は名前の形ではない')
  assert.equal(emojiQuery('https://x.com', 13), null, 'URL の `:` の後ろは `//` で名前にならない')
})

test('emojiQuery: caret より後ろは見ない。閉じた `:` の後ろからは新しい候補として見る', () => {
  assert.deepEqual(emojiQuery(':tada: あと', 5), { start: 0, query: 'tada' }, 'caret が閉じる前なら打ちかけ')
  assert.equal(emojiQuery(':tada:', 6), null, '閉じた直後は検索語が空なので開かない')
})

test('emojiQuery: 時刻は形が通るが、当たる絵文字が無いので候補は空（呼び出し側で開かない）', () => {
  const hit = emojiQuery('14:08:30', 8)
  assert.deepEqual(hit, { start: 5, query: '30' })
  assert.deepEqual(filterEmoji(hit!.query), [], '当たりが無いのでメニューは開かない')
})

test('filterEmoji: 前方一致が先、その後ろに部分一致。上限で切る', () => {
  const ta = filterEmoji('ta')
  assert.equal(ta[0]?.name, 'tada', '前方一致が先頭')
  assert.ok(ta.some((e) => e.name === 'crystal_ball'), '部分一致も拾う')
  const prefix = ta.findIndex((e) => !e.name.startsWith('ta'))
  assert.ok(ta.slice(prefix).every((e) => !e.name.startsWith('ta')), '前方一致がまとまって先に並ぶ')
  assert.deepEqual(filterEmoji('tada'), [{ name: 'tada', char: '🎉' }])
  assert.deepEqual(filterEmoji('zzzz'), [])
  assert.equal(filterEmoji('a', 3).length, 3, '上限で切る')
  assert.deepEqual(filterEmoji('TA').slice(0, 1), [{ name: 'tada', char: '🎉' }], '大文字小文字は無視')
})
