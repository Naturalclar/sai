import { test } from 'node:test'
import assert from 'node:assert/strict'
import { WAITING_SAID_FRESH_MS, saysWaiting, waitingTail, waitingUnscheduled } from './waitingSaid.ts'

// 作り物の返答（実際の返答は置かない）。末尾の言い方ごとに 1 つずつ
const WAITING = [
  'PR を出しました。CI の結果を待ちます。',
  'レビューを別プロセスに投げました。結果が届き次第、マージします。',
  'テストを回しています。通ったら報告します。',
  'push しました。チェックが終わり次第、続けます。',
  'いま CI が走っています。完了次第お知らせします。',
  '直しを push しました。CI が緑になったら squash マージします。',
  'ビルドを待っています。',
  '一式を裏で回しています。終わったら結果を貼ります。',
  'CI を待ってからマージします。',
  'Pushed the fix. Waiting for CI.',
  'Opened the PR. I will merge once the checks pass.',
  'CI が通ったら報告します。マージは「マージして」を待ちます。',
]
const NOT_WAITING = [
  'PR を出しました。マージは「マージして」を待ちます。',
  '直しました。ご指示をお待ちします。',
  '2 案あります。どちらにするか、ご判断を待ちます。',
  '確認が取れたら進めます。あなたの返事を待っています。',
  'マージして、と言われたら入れます。',
  'マージしました。ブランチも消しています。',
  '少々お待ちください。',
  'CI は通りました。待つものはありません。',
  'Ready to merge. Let me know when you want it in.',
  'Waiting for your approval before merging.',
  // 待ちではない「〜たら」（機械が終わるものの話ではない）
  'エラーが出たら README の「詰まったとき」の順に見ます。',
  '相手の返答が届いたら同じ並びに出します。',
  '届いたら続けます。',
  // 人の一言が合図
  'レビューが完了したら、「確認して」と言ってもらえれば指摘を見ます。',
  '「マージして」でレビューと CI を待ってからマージします。',
  // 人への頼み・問いかけ
  'テストで問題が出たら教えてください。',
  'CI が通ったらマージしてよいですか？',
  '結果が出たらどうしますか',
  // ci を含むだけの語（specific・decision）は、機械が終わるものではない
  'specific な指定が届いたら続けます。',
  'We will continue once the decision lands.',
  '',
]

test('saysWaiting: 末尾が「待ちます／届き次第／通ったら」の類なら true。人を待っている文・終わった報告は false', () => {
  for (const text of WAITING) assert.equal(saysWaiting(text), true, text)
  for (const text of NOT_WAITING) assert.equal(saysWaiting(text), false, text)
})

test('saysWaiting: 見るのは末尾だけ。途中の「待ちます」・コードブロック・引用の中は見ない', () => {
  const early = ['CI を待ちます。', '', '（数分後）', 'CI が通りました。', 'squash マージしました。', 'ブランチを消しました。', '以上です。'].join('\n')
  assert.equal(saysWaiting(early), false, '途中で言っても、末尾が終わった報告なら出さない')
  assert.equal(saysWaiting(['終わりました。', '```', 'echo "CI を待ちます"', '```'].join('\n')), false)
  assert.equal(saysWaiting(['終わりました。', '> CI の結果を待ちます'].join('\n')), false)
  assert.equal(waitingTail(['a', '', 'b', 'c', 'd', 'e'].join('\n')), 'b\nc\nd\ne', '空でない行を後ろから 4 つ')
  assert.equal(saysWaiting(['長い説明です。', '', '- 直した所 1', '- 直した所 2', '', 'CI の結果が届き次第、報告します。'].join('\n')), true)
})

test('waitingUnscheduled: 1 つでも分からなければ出さない（人が次に打った・もう回っている・待ちがある・PR が決まらない・古い）', () => {
  const now = Date.parse('2026-10-09T03:00:00Z')
  const base = { lastIsTurn: true, text: 'PR を出しました。CI の結果を待ちます。', endedMs: now - 5 * 60_000, now, busy: false, waits: 0, handled: false, prs: [42] }
  assert.equal(waitingUnscheduled(base), 42)
  assert.equal(waitingUnscheduled({ ...base, lastIsTurn: false }), 0, '人が次に何か打った・待ちの行が来た')
  assert.equal(waitingUnscheduled({ ...base, busy: true }), 0, 'もう次のターンが回っている')
  assert.equal(waitingUnscheduled({ ...base, waits: 1 }), 0, '待ちが預けてある')
  assert.equal(waitingUnscheduled({ ...base, handled: true }), 0, 'ループが組まれている・このターンの印は片付けた')
  assert.equal(waitingUnscheduled({ ...base, prs: [] }), 0, 'PR が見つからない')
  assert.equal(waitingUnscheduled({ ...base, prs: [42, 43] }), 0, 'PR が 1 つに決まらない')
  assert.equal(waitingUnscheduled({ ...base, endedMs: now - WAITING_SAID_FRESH_MS - 1 }), 0, '古いターン')
  assert.equal(waitingUnscheduled({ ...base, endedMs: NaN }), 0, '時刻が読めない')
  assert.equal(waitingUnscheduled({ ...base, text: 'マージは「マージして」を待ちます。' }), 0, '人を待っている')
})
