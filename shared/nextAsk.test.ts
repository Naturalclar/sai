import { test } from 'node:test'
import assert from 'node:assert/strict'
import { NEXT_ASK_MAX_CHARS, cleanNextAsk, nextAskPrompt } from './nextAsk.ts'

test('nextAskPrompt: 人の立場で 1 文。口調（性格）は足さない。直前の入力があれば添える', () => {
  const p = nextAskPrompt('テストを足して', 'テストを 3 つ足したよ。')
  assert.match(p, /あなたが次に送る文/)
  assert.match(p, new RegExp(`${NEXT_ASK_MAX_CHARS} 文字以内`))
  assert.match(p, /直前にあなたが送った文:\nテストを足して/)
  assert.match(p, /エージェントの返答:\nテストを 3 つ足したよ。$/)
  // 一言（digestPrompt）と違って口調の指示は入れない。人が打つ文なので
  assert.ok(!p.includes('口調'))
})

test('nextAskPrompt: 直前の入力が無ければその節ごと落とす', () => {
  const p = nextAskPrompt('  ', '終わったよ。')
  assert.ok(!p.includes('直前にあなたが送った文'))
  assert.match(p, /エージェントの返答:\n終わったよ。$/)
})

// 作例の数字を書き写して、実在する別の issue へのリンクになる事故（#268）を同じ口で繰り返さない
test('nextAskPrompt: 作例に具体的な番号を書かない', () => {
  assert.ok(!/#\d/.test(nextAskPrompt('入力', '返答')))
})

test('cleanNextAsk: 最初の中身のある行だけ。前置き・箇条書きの印・囲みを落とす', () => {
  assert.equal(cleanNextAsk('マージして'), 'マージして')
  assert.equal(cleanNextAsk('\n\n  マージして  \n2 つ目の案\n'), 'マージして')
  assert.equal(cleanNextAsk('案: マージして'), 'マージして')
  assert.equal(cleanNextAsk('提案：マージして'), 'マージして')
  assert.equal(cleanNextAsk('- マージして'), 'マージして')
  assert.equal(cleanNextAsk('1. マージして'), 'マージして')
  assert.equal(cleanNextAsk('「マージして」'), 'マージして')
  assert.equal(cleanNextAsk('"マージして"'), 'マージして')
  assert.equal(cleanNextAsk('案: 「マージして」'), 'マージして')
})

test('cleanNextAsk: 作れていなければ空。長すぎれば切る', () => {
  assert.equal(cleanNextAsk(''), '')
  assert.equal(cleanNextAsk('\n  \n'), '')
  assert.equal(cleanNextAsk('あ'.repeat(NEXT_ASK_MAX_CHARS + 10)), 'あ'.repeat(NEXT_ASK_MAX_CHARS))
  // 囲みだけの返事で中身が消えない（片方しか無ければ触らない）
  assert.equal(cleanNextAsk('「マージして'), '「マージして')
})
