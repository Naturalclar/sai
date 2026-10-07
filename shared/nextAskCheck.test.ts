// 「次に送る文面の案」が人の返信として読めるかの確かめ（#729）。本文も案も作り物
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { nextAskIssues, similarity } from './nextAskCheck.ts'

const codes = (nextAsk: string, text: string) => nextAskIssues(nextAsk, text).map((i) => i.code)

const QUESTION = '読み直さない形に直しました。\n\nこの変更で PR を作成しますか？'
const DECLARATION = '再現しました。空白が入ると後ろの語が無視されます。\n\n次は修正に入ります。'
const REQUEST = '印刷用の余白を直しました。\n\n実機で確認してください。'
const REPORT = 'README の手順を書き直しました。古い画像 2 枚は消しています。'

test('聞き返し: 本文の問いをそのまま返す・エージェントが伺う形の問いは拾う', () => {
  assert.deepEqual(codes('この変更で PR を作成しますか？', QUESTION), ['question_back'])
  assert.deepEqual(codes('PR を作成しますか', QUESTION), ['question_back'], '疑問符が無くても')
  // 本文に無い問いでも、「〜しますか」「〜しましょうか」は人がエージェントに言う形ではない
  assert.deepEqual(codes('CI の完了を待ちますか？', REPORT), ['question_back'])
  assert.deepEqual(codes('先に直しましょうか？', REPORT), ['question_back'])
})

test('聞き返し: 人がエージェントに聞く問いは拾わない', () => {
  assert.deepEqual(codes('なぜ画像を消した？', REPORT), [])
  assert.deepEqual(codes('消した画像はどれですか？', REPORT), [])
})

test('問いを指示に直した文は、本文の問いと字面が近くても拾わない', () => {
  assert.deepEqual(codes('PR を作成して', QUESTION), [])
  assert.deepEqual(codes('はい、PR を作成してください', QUESTION), [])
  assert.deepEqual(codes('作成はまだ待って', QUESTION), [])
})

test('宣言: 「〜します」「〜しました」で終わる文を拾う。頼み・礼の「〜ます」は拾わない', () => {
  assert.deepEqual(codes('修正に入ります。', DECLARATION), ['declaration'])
  assert.deepEqual(codes('CI の結果を確認します', REPORT), ['declaration'])
  assert.deepEqual(codes('手順を書き直しました！', REPORT), ['declaration'])
  assert.deepEqual(codes('修正をお願いします', DECLARATION), [])
  assert.deepEqual(codes('それで進めてもらえると助かります', DECLARATION), [])
  assert.deepEqual(codes('修正に入って', DECLARATION), [])
  // 選択肢への答えは人の文
  assert.deepEqual(codes('週を選びます', '週と月のどちらがよいですか？'), [])
  assert.deepEqual(codes('月にします', '週と月のどちらがよいですか？'), [])
})

test('頼み返し: 本文で人に頼んでいることを、そのまま頼み返したものを拾う', () => {
  assert.deepEqual(codes('実機で確認してください', REQUEST), ['request_back'])
  assert.deepEqual(codes('実機で確認して', REQUEST), ['request_back'], '「ください」を落としただけ')
  // 本文に無い頼みは、人からエージェントへの指示
  assert.deepEqual(codes('余白をもう少し広げてください', REQUEST), [])
  assert.deepEqual(codes('確認したので、次に進めて', REQUEST), [])
})

test('写し: 本文の報告の文をそのまま返したものを拾う', () => {
  const text = '遅いのは 3 つのテストだった。まだ何も変えていない。'
  assert.deepEqual(codes('遅いのは 3 つのテストだった', text), ['copy'])
  assert.deepEqual(codes('遅い 3 つのテストを直して', text), [])
  // 宣言の形の写しは、宣言として数える（同じ文を 2 つの理由で数えない）
  assert.deepEqual(codes('古い画像 2 枚は消しています', REPORT), ['declaration'])
})

test('空の案は何も言わない・コードブロックの中の文は本文の文と数えない', () => {
  assert.deepEqual(codes('', QUESTION), [])
  assert.deepEqual(codes('  ', QUESTION), [])
  assert.deepEqual(codes('設定を確認して', '直しました。\n\n```\n設定を確認してください\n```'), [])
})

test('理由は作り直しのプロンプトにそのまま入る文になっている', () => {
  for (const [nextAsk, text] of [['PR を作成しますか？', QUESTION], ['修正に入ります', DECLARATION], ['実機で確認してください', REQUEST], ['遅いのは 3 つのテストだった', '遅いのは 3 つのテストだった。']] as const) {
    const [issue] = nextAskIssues(nextAsk, text)
    assert.ok(issue && issue.hint.length > 10, nextAsk)
    // 作例に具体的な番号・本文の中身の語を置かない（書き写される）
    assert.doesNotMatch(issue.hint, /#\d|PR|README|実機|テスト/)
  }
})

test('similarity: 同じ文は 1、関係ない文は 0 に近い。空白と記号は無視する', () => {
  assert.equal(similarity('PR を作成しますか？', 'PRを作成しますか'), 1)
  assert.ok(similarity('PR を作成して', '画像を消しました') < 0.2)
  assert.equal(similarity('', 'あ'), 0)
  assert.equal(similarity('あ', 'あ'), 1)
})
