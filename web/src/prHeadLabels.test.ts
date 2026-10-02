import { test } from 'node:test'
import assert from 'node:assert/strict'
import { draftCount, draftSummary, insertLabel, reviewLabel } from './prHeadLabels.ts'

test('reviewLabel: 下書きが無ければ数を付けない（ボタンは 0 件でも出すので「0」は書かない）', () => {
  assert.deepEqual(reviewLabel(0, false), { full: 'Submit review', short: 'レビュー' })
})

test('reviewLabel: 行コメントだけ・全体のコメントだけ・両方', () => {
  assert.deepEqual(reviewLabel(3, false), { full: 'Submit review 3', short: 'レビュー 3' })
  assert.deepEqual(reviewLabel(0, true), { full: 'Submit review 1', short: 'レビュー 1' })
  assert.deepEqual(reviewLabel(3, true), { full: 'Submit review 4', short: 'レビュー 4' })
})

test('insertLabel: 入れる先の名前を出し、数えるのは行コメントだけ', () => {
  assert.deepEqual(insertLabel(0, 'かなで'), { full: '「かなで」の入力欄に入れる', short: '入力欄へ' })
  assert.deepEqual(insertLabel(2, 'かなで'), { full: '「かなで」の入力欄に入れる 2', short: '入力欄へ 2' })
  assert.deepEqual(insertLabel(2, ''), { full: '入力欄に入れる 2', short: '入力欄へ 2' })
})

test('draftCount: 負の数は 0 に丸める', () => {
  assert.equal(draftCount(-1, false), 0)
  assert.equal(draftCount(2, true), 3)
})

test('draftSummary: 0 件は空（案内の文を出す）・行コメントだけ・全体のコメントだけ・両方', () => {
  assert.equal(draftSummary(0, false), '')
  assert.equal(draftSummary(3, false), '下書き: 行コメント 3 件')
  assert.equal(draftSummary(0, true), '下書き: 全体のコメント')
  assert.equal(draftSummary(3, true), '下書き: 行コメント 3 件・全体のコメント')
})
