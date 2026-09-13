// #346。実データ（手元の digest.jsonl 667 件）で見つけた型をそのまま置く。
// 本文と一言は、長さだけ詰めて形は変えていない
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { digestIssues, quotedRequests } from './digestCheck.ts'
import { DIGEST_MAX_CHARS } from './persona.ts'

const codes = (source: string, summary: string) => digestIssues(source, summary).map((i) => i.code)

test('quotedRequests: 引用された依頼だけを拾う。引用の無い指示は拾わない', () => {
  assert.deepEqual(quotedRequests('よければ「マージして」と言ってください。'), ['マージして'])
  assert.deepEqual(quotedRequests('着手するときは `#49 に着手して` と言ってもらえれば進めます'), ['#49 に着手して'])
  assert.deepEqual(quotedRequests('復帰後に「続けて」と言ってもらえれば、残りをやります'), ['続けて'])
  assert.deepEqual(quotedRequests('マージしてください。'), [], '引用が無ければ拾わない')
  assert.deepEqual(quotedRequests('「許可が要る」と言って止まります'), ['許可が要る'], '拾うが、問いかけでなければ咎めない')
})

test('引用された依頼が問いかけに化けたら見つける（#346 のきっかけ）', () => {
  // 本文には PR 番号も入っている（実データと同じ形）
  const source = 'PR #284 を出しました。CI は 3 ジョブとも通り、#223 と #320 も同じ形です。main との衝突もありません。マージはまだしていないので、よければ「マージして」と言ってください。'
  assert.deepEqual(codes(source, 'PR #284 作成、モデルボタンを Default に変更。マージして？'), ['quoted_request'])
  assert.deepEqual(codes(source, 'PR 320 作成、CI通りマージ可能！よければマージして？✅'), ['quoted_request'])
  assert.deepEqual(codes(source, 'PR #223 CI完了！merge可能！マージしていい？'), ['quoted_request'], '「〜していい？」も問いかけ')
})

test('引用のまま残っていれば文句を言わない。問いかけでなければ咎めない', () => {
  const source = 'PR #284 を出しました。よければ「マージして」と言ってください。'
  assert.deepEqual(codes(source, 'PR #284 を出したよ。よければ「マージして」と言ってね'), [])
  assert.deepEqual(codes(source, 'PR #284 を出したよ。マージしてと言ってね'), [], '引用符が落ちても、問いかけでなければ意味は変わらない')
  assert.deepEqual(codes('「許可が要る」と言って止まります', 'ツールが拒否されて止まったよ。許可を足す？'), [], '本文の引用と関係ない問いかけは咎めない')
})

test('本文にエージェント自身の問いかけがあれば、一言が問いかけでも構わない', () => {
  const source = 'PR #66 の CI は 3 ジョブとも通りました。マージしますか？'
  assert.deepEqual(codes(source, 'PR #66 通ったよ、マージする？'), [])
})

test('本文に無い番号を書いたら見つける（#268 の裏返し）', () => {
  const source = 'README を書き換えて PR を出しました。CI は pass です。'
  assert.deepEqual(codes(source, 'PR #12 を出したよ、CI も通った'), ['invented_number'])
  assert.deepEqual(codes('PR 64 を出しました（https://github.com/o/r/pull/64）', 'PR #64 出した、CI pass'), [], '本文にある番号はよい')
  assert.deepEqual(codes('issue 168 を作りました', 'PR 〈168〉作成、着手待ち'), [], '〈〉付きでも本文にあればよい')
})

test('要約せずプロンプトに答えた、前置き、引用符で囲んだ、は見つける', () => {
  assert.deepEqual(codes('ALPHA', '変換対象のコーディングエージェントの返答文をいただけますか？'), ['meta_reply'])
  assert.deepEqual(codes('直したよ', '一言: 直したよ'), ['prefix'])
  assert.deepEqual(codes('直したよ', '「直しておいたよ」'), ['prefix'])
  assert.deepEqual(codes('直したよ', '直しておいたよ'), [])
})

test('長さと空。長さは文字数（絵文字も 1 つと数える）', () => {
  assert.deepEqual(codes('やった', ''), ['empty'])
  assert.deepEqual(codes('やった', '   '), ['empty'])
  assert.deepEqual(codes('やった', 'あ'.repeat(DIGEST_MAX_CHARS)), [])
  assert.deepEqual(codes('やった', 'あ'.repeat(DIGEST_MAX_CHARS + 1)), ['too_long'])
  const long = digestIssues('やった', 'あ'.repeat(DIGEST_MAX_CHARS + 5))
  assert.match(long[0]!.hint, new RegExp(`${DIGEST_MAX_CHARS + 5} 文字`), '実際の長さを理由に入れる（作り直しに渡す）')
})

test('複数あれば、意味が変わるものが先に並ぶ', () => {
  const source = 'よければ「マージして」と言ってください。'
  const got = digestIssues(source, `一言: マージして？ ${'あ'.repeat(DIGEST_MAX_CHARS)}`)
  assert.deepEqual(got.map((i) => i.code), ['quoted_request', 'prefix', 'too_long'])
  assert.ok(got.every((i) => i.hint.length > 0), '理由は全部埋める（作り直しのプロンプトに入る）')
})
