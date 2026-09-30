import { test } from 'node:test'
import assert from 'node:assert/strict'
import { CONTEXT_WARN_TOKENS, contextLabel, contextRevKey, contextTitle, contextWarns } from './contextSize.ts'

test('contextLabel: 1000 未満はそのまま、千は k、百万は小数 1 桁の M（切り上げない）。0 は空', () => {
  assert.equal(contextLabel(0), '')
  assert.equal(contextLabel(undefined), '')
  assert.equal(contextLabel(812), '812')
  assert.equal(contextLabel(830_400), '830k')
  assert.equal(contextLabel(999_499), '999k')
  assert.equal(contextLabel(999_700), '1.0M', '1000k にはしない（#441 のレビュー）')
  assert.equal(contextLabel(1_249_999), '1.2M')
  assert.equal(contextLabel(4_157_178), '4.1M')
})

test('contextWarns: 閾値ちょうどから警告。分からない（0 / undefined）は警告しない', () => {
  assert.equal(contextWarns(CONTEXT_WARN_TOKENS - 1), false)
  assert.equal(contextWarns(CONTEXT_WARN_TOKENS), true)
  assert.equal(contextWarns(0), false)
  assert.equal(contextWarns(undefined), false)
})

test('contextTitle: 読み直す量だと書き、閾値を超えたら切り替えどきを添える', () => {
  assert.match(contextTitle(123_456), /123,456 トークン\n返信 1 回でこの量を読み直します$/)
  assert.match(contextTitle(CONTEXT_WARN_TOKENS), /400k を超えています/)
})

test('contextRevKey: 1 万未満の増減では変わらず、閾値をまたいだら変わる', () => {
  assert.equal(contextRevKey(120_100), contextRevKey(129_900))
  assert.notEqual(contextRevKey(120_000), contextRevKey(130_000))
  assert.notEqual(contextRevKey(CONTEXT_WARN_TOKENS - 1), contextRevKey(CONTEXT_WARN_TOKENS))
})
