import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ELLIPSIS, EXCERPT_AFTER, EXCERPT_BEFORE, excerptOf, findHits, matchesAll, mergeHits, searchWords, splitHighlight } from './search.ts'

test('searchWords: 小文字にして空白で割る。空白だけなら 0 語', () => {
  assert.deepEqual(searchWords('SAI Kanade'), ['sai', 'kanade'])
  assert.deepEqual(searchWords('  　'), ['　'.trim()].filter(Boolean), '全角空白も \\s なので落ちる')
  assert.deepEqual(searchWords(''), [])
  assert.deepEqual(searchWords('あ  い'), ['あ', 'い'])
  assert.equal(searchWords('x'.repeat(500)).join('').length, 200, '長すぎる q は切る')
})

test('matchesAll: 全部の語が入っていれば当たり（AND、部分一致、大文字小文字を無視）', () => {
  assert.equal(matchesAll('PR #206 を squash マージしました', ['squash']), true)
  assert.equal(matchesAll('PR #206 を SQUASH マージしました', ['squash', 'pr']), true)
  assert.equal(matchesAll('PR #206 を squash マージしました', ['squash', 'rebase']), false, 'AND なので片方だけでは当たらない')
  assert.equal(matchesAll('なんでも', []), false, '語が無ければ当てない（空の q で全件返さない）')
})

test('findHits: 出てくる場所を全部。重なりと隣り合いは畳む', () => {
  assert.deepEqual(
    findHits('abc-abc', ['abc']),
    [
      [0, 3],
      [4, 3],
    ],
    '離れていれば別々',
  )
  assert.deepEqual(findHits('abcabc', ['abc']), [[0, 6]], '隣り合っていれば 1 つ（強調を分けない）')
  // 'ab' と 'b' は重なるので 1 つに畳む
  assert.deepEqual(findHits('ab', ['ab', 'b']), [[0, 2]])
  assert.deepEqual(findHits('xAbX', ['ab']), [[1, 2]], '大文字小文字を無視しても位置は元の文字数')
  assert.deepEqual(findHits('none', ['zzz']), [])
})

test('mergeHits: 隣り合いも畳む。開始の昇順', () => {
  assert.deepEqual(
    mergeHits([
      [5, 2],
      [0, 3],
    ]),
    [
      [0, 3],
      [5, 2],
    ],
  )
  assert.deepEqual(mergeHits([[0, 3], [3, 2]]), [[0, 5]], '隣り合いは 1 つ')
  assert.deepEqual(mergeHits([[0, 5], [2, 1]]), [[0, 5]], '内側は飲まれる')
  assert.deepEqual(mergeHits([]), [])
})

test('excerptOf: 当たった最初の場所を中心に切り出し、前後が切れていれば … を付ける', () => {
  const body = `${'あ'.repeat(100)}きーわーど${'い'.repeat(200)}`
  const e = excerptOf(body, ['きーわーど'])
  assert.ok(e.text.startsWith(ELLIPSIS), '前が切れている')
  assert.ok(e.text.endsWith(ELLIPSIS), '後ろも切れている')
  assert.ok(e.text.includes('きーわーど'))
  assert.equal(e.hits.length, 1)
  // 抜粋の座標で切り出すと、ちゃんと当たった語になる
  const [start, length] = e.hits[0]!
  assert.equal(e.text.slice(start, start + length), 'きーわーど')
})

test('excerptOf: 短い本文はそのまま（… を付けない）', () => {
  const e = excerptOf('マージして', ['マージ'])
  assert.equal(e.text, 'マージして')
  assert.deepEqual(e.hits, [[0, 3]])
})

test('excerptOf: 改行は空白に潰し、潰したあとの座標で返す', () => {
  const e = excerptOf('一行目\n\n  二行目に きーわーど がある', ['きーわーど'])
  assert.equal(e.text, '一行目 二行目に きーわーど がある')
  const [start, length] = e.hits[0]!
  assert.equal(e.text.slice(start, start + length), 'きーわーど')
})

test('excerptOf: 当たりが無ければ頭を出すだけ（hits は空）', () => {
  const e = excerptOf('あ'.repeat(500), ['zzz'])
  assert.equal(e.hits.length, 0)
  assert.equal(e.text.length, EXCERPT_BEFORE + EXCERPT_AFTER)
  assert.ok(!e.text.includes(ELLIPSIS), '当たりが無いときは印を付けない（切り出しではなく頭）')
})

test('excerptOf: 抜粋に入りきる範囲の当たりは全部返す（2 語 AND）', () => {
  const e = excerptOf('squash マージしました。issue も閉じました', ['squash', 'issue'])
  assert.equal(e.hits.length, 2)
  assert.equal(e.text.slice(e.hits[0]![0], e.hits[0]![0] + e.hits[0]![1]), 'squash')
  assert.equal(e.text.slice(e.hits[1]![0], e.hits[1]![0] + e.hits[1]![1]), 'issue')
})

test('excerptOf: 抜粋の外に出た当たりは落とす（座標がずれない）', () => {
  const body = `きーわーど${'あ'.repeat(400)}きーわーど`
  const e = excerptOf(body, ['きーわーど'])
  assert.equal(e.hits.length, 1, '2 つ目は抜粋の外')
  const [start, length] = e.hits[0]!
  assert.equal(e.text.slice(start, start + length), 'きーわーど')
})

test('splitHighlight: 強調する場所で割る。並べ直すと元に戻る', () => {
  const parts = splitHighlight('abcdef', [[2, 2]])
  assert.deepEqual(parts, [
    { text: 'ab', hit: false },
    { text: 'cd', hit: true },
    { text: 'ef', hit: false },
  ])
  assert.equal(parts.map((p) => p.text).join(''), 'abcdef')

  assert.deepEqual(splitHighlight('abc', []), [{ text: 'abc', hit: false }], '当たりが無ければ 1 つ')
  assert.deepEqual(splitHighlight('abc', [[0, 3]]), [{ text: 'abc', hit: true }], '全部当たり')
  // 先頭と末尾に当たりがあっても空の断片を作らない
  assert.deepEqual(splitHighlight('ab', [[0, 1], [1, 1]]), [
    { text: 'a', hit: true },
    { text: 'b', hit: true },
  ])
})
