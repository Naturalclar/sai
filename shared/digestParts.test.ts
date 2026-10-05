import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cleanWhat, digestPlan, joinDigest } from './digestParts.ts'

test('digestPlan: 頼みの文があれば 2 つで組む。報告だけなら何が起きたかだけ。抜ける文が無ければ今までどおり（#713）', () => {
  assert.deepEqual(digestPlan('直しました。よければ「マージして」と言ってください。'), { kind: 'two', next: 'よければ「マージして」と言ってください。' })
  assert.deepEqual(digestPlan('直しました。テストは通っています。'), { kind: 'report' })
  assert.deepEqual(digestPlan('CI が落ちています。もう一度回したほうが確実です。'), { kind: 'full' }, '頼みの形でない言い方')
  assert.deepEqual(digestPlan('A と B のどちらにしますか？'), { kind: 'full' }, '質問')
  assert.deepEqual(digestPlan('Opened the PR. CI is green. Say "merge it" when you are ready.'), { kind: 'full' }, '日本語でない本文は報告だけと決めつけない')
  assert.deepEqual(digestPlan('`fooBarBaz()` を直しました。'), { kind: 'report' }, 'コードの中の英字は数えない')
})

test('cleanWhat / joinDigest: 言い換えた頼みを落とし、本文の文を続けて 1 つにする（見出しは付けない）', () => {
  const two = digestPlan('直しました。よければ「マージして」と言ってください。')
  assert.equal(cleanWhat(two, ' 直したよ！マージして？ '), '直したよ！')
  assert.equal(cleanWhat({ kind: 'full' }, '直したよ！マージして？'), '直したよ！マージして？', '2 つで組まない回は触らない')
  assert.equal(joinDigest('直したよ！', 'よければ「マージして」と言ってください。'), '直したよ！よければ「マージして」と言ってください。')
  assert.equal(joinDigest('直しました', '確認してください。'), '直しました。確認してください。', '文の終わりが無ければ句点を足す')
  assert.equal(joinDigest('PR 出したよ🎉', '確認してください。'), 'PR 出したよ🎉確認してください。', '絵文字で終わっていれば句点を足さない')
  assert.equal(joinDigest('直したよ✨️', '確認してください。'), '直したよ✨️確認してください。')
  assert.equal(joinDigest('直したよ！', ''), '直したよ！')
  assert.equal(joinDigest('', '確認してください。'), '確認してください。')
})
