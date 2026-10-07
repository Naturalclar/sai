import { test } from 'node:test'
import assert from 'node:assert/strict'
import { NEXT_ASK_MAX_CHARS, cleanNextAsk, composeNextAsk, nextAskPrompt, quotedNextAsk } from './nextAsk.ts'
import { nextAskIssues } from './nextAskCheck.ts'

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

test('quotedNextAsk: 本文に引用された人の言葉があれば、それをそのまま案にする（#713）', () => {
  assert.equal(quotedNextAsk('PR を出しました。よければ「マージして」と言ってください。'), 'マージして')
  assert.equal(quotedNextAsk('「調べて」と言われた件です。終わったら『進めて』と伝えてください'), '進めて', '2 つあれば最後')
  assert.equal(quotedNextAsk('マージしてください'), '', '引用でなければ取らない（口で作る）')
  assert.equal(quotedNextAsk('「マージ」の手順を足しました'), '', '「と言って」が無い引用は頼みではない')
  assert.equal(quotedNextAsk('さきほど「後で」と言われた件を直しました。'), '', '言われた言葉の引用は頼みではない')
  assert.equal(quotedNextAsk('「connection refused」と言うエラーが出ます。'), '')
  assert.equal(quotedNextAsk(''), '')
})

// ---- #729: 案を人の返信の形にする（プロンプトを形で縛る・機械で確かめて作り直す・駄目なら出さない）
test('nextAskPrompt: 作り直しは前の案と直してほしい点を足す。本文は末尾のまま', () => {
  const issues = nextAskIssues('修正に入ります', '次は修正に入ります。')
  const p = nextAskPrompt('入力', '次は修正に入ります。', { retry: { nextAsk: '修正に入ります', issues } })
  assert.match(p, /前に作った文: 修正に入ります/)
  assert.match(p, /エージェントが言う宣言/)
  assert.match(p, /エージェントの返答:\n次は修正に入ります。$/)
})

test('composeNextAsk: 人の返信として読めればそのまま（口は 1 回）', async () => {
  const prompts: string[] = []
  const r = await composeNextAsk('入力', '次は修正に入ります。', async (p) => (prompts.push(p), '修正に入って'))
  assert.deepEqual(r, { next_ask: '修正に入って', first: [], dropped: [] })
  assert.equal(prompts.length, 1)
})

test('composeNextAsk: 読めなければ 1 回だけ作り直し、直れば出す', async () => {
  const prompts: string[] = []
  const answers = ['修正に入ります。', '「修正に入って」']
  const r = await composeNextAsk('入力', '次は修正に入ります。', async (p) => (prompts.push(p), answers.shift()!))
  assert.deepEqual(r, { next_ask: '修正に入って', first: ['declaration'], dropped: [] })
  assert.equal(prompts.length, 2)
  assert.match(prompts[1]!, /前に作った文: 修正に入ります。/)
})

test('composeNextAsk: 作り直しても読めなければ出さない（3 回目は呼ばない）', async () => {
  let calls = 0
  const r = await composeNextAsk('入力', 'この変更で PR を作成しますか？', async () => (calls++ === 0 ? '修正に入ります' : 'PR を作成しますか？'))
  assert.deepEqual(r, { next_ask: '', first: ['declaration'], dropped: ['question_back'] })
  assert.equal(calls, 2)
})

test('composeNextAsk: 空の案は作り直さない（作れなかっただけ）。確かめを切れば 1 回目をそのまま返す', async () => {
  let calls = 0
  assert.deepEqual(await composeNextAsk('', '報告です。', async () => (calls++, '  ')), { next_ask: '', first: [], dropped: [] })
  assert.equal(calls, 1)
  assert.deepEqual(await composeNextAsk('', '次は修正に入ります。', async () => '修正に入ります', { check: false }), { next_ask: '修正に入ります', first: [], dropped: [] })
})
