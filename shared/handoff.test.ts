import { test } from 'node:test'
import assert from 'node:assert/strict'
import { handoffFirstText, handoffReady, HANDOFF_MARK, HANDOFF_PROMPT, isHandoffPrompt } from './handoff.ts'

const turn = (ts: string, user_text: string, text: string, event = 'Stop') => ({ ts, event, text, user_text })

test('isHandoffPrompt: 依頼文の 1 行目で始まる入力だけ', () => {
  assert.equal(isHandoffPrompt(HANDOFF_PROMPT), true)
  assert.equal(isHandoffPrompt(`\n${HANDOFF_PROMPT}`), true)
  assert.equal(isHandoffPrompt(HANDOFF_PROMPT.slice(0, 200)), true, '行の上限で切られていても当たる')
  assert.equal(isHandoffPrompt(`さっきの ${HANDOFF_MARK}`), false, '途中に引いただけの文は当てない')
  assert.equal(isHandoffPrompt('引き継ぎを書いて'), false)
  assert.equal(isHandoffPrompt(undefined), false)
  assert.equal(HANDOFF_PROMPT.split('\n')[0], HANDOFF_MARK)
})

test('handoffReady: 最後のターン完了の入力が依頼文のときだけ、その返答を返す（#442）', () => {
  const a = turn('2026-10-01T10:00:00+09:00', '着手して', '終わりました')
  const h = turn('2026-10-01T11:00:00+09:00', HANDOFF_PROMPT, ' いまは #1 の途中です ')
  assert.deepEqual(handoffReady([a, h]), { ts: h.ts, text: 'いまは #1 の途中です' })
  assert.deepEqual(handoffReady([h, a]), { ts: h.ts, text: 'いまは #1 の途中です' }, '並びではなく時刻で最後を選ぶ')
  // あとから別のターンが回っていれば、古い引き継ぎでは始めない
  assert.equal(handoffReady([a, h, turn('2026-10-01T12:00:00+09:00', '番号も書いて', '直しました')]), null)
  // ターン完了ではない行（待ち・入力）は「最後のターン」に数えない
  assert.deepEqual(handoffReady([h, turn('2026-10-01T12:00:00+09:00', '', '許可待ち: Bash: ls', 'PermissionRequest')])?.ts, h.ts)
  // 引き継ぎのあとに人が入力していて、まだ終わっていない（#622 のレビュー）。前の入力は関係ない
  assert.equal(handoffReady([h, turn('2026-10-01T11:30:00+09:00', '続けて', '', 'UserPromptSubmit')]), null)
  assert.deepEqual(handoffReady([turn('2026-10-01T10:59:00+09:00', HANDOFF_PROMPT, '', 'UserPromptSubmit'), h])?.ts, h.ts)
  // 返答が空・まだ終わっていない・行が無い
  assert.equal(handoffReady([turn('2026-10-01T11:00:00+09:00', HANDOFF_PROMPT, '  ')]), null)
  assert.equal(handoffReady([a]), null)
  assert.equal(handoffReady([]), null)
})

test('handoffFirstText: 引き継ぎの本文をそのまま含む', () => {
  const out = handoffFirstText('いまは #1 の途中です')
  assert.ok(out.endsWith('\n\nいまは #1 の途中です'))
  assert.equal(isHandoffPrompt(out), false, '新しいセッションの最初の入力は、引き継ぎの依頼とは読まない')
})
