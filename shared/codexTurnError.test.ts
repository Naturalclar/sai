import { test } from 'node:test'
import assert from 'node:assert/strict'
import { codexErrorText, codexTurnErrorReason, queuedTurnError } from './codexTurnError.ts'

const SINCE = Date.parse('2026-09-16T09:41:54.000Z')
const line = (timestamp: string, type: string, payload: unknown) => JSON.stringify({ timestamp, type, payload })
const userItem = (timestamp: string, text: string) =>
  line(timestamp, 'response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text }] })
const event = (timestamp: string, payload: Record<string, unknown>) => line(timestamp, 'event_msg', payload)
/** 実データ（2026-09-16 の 01a0a98f）の形 */
const LIMIT = { message: "You've hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro), or try again later.", codexErrorInfo: 'usageLimitExceeded' }

test('codexErrorText: 素の文はそのまま、API の応答を JSON にした文字列は中の message を採る', () => {
  assert.equal(codexErrorText(LIMIT), LIMIT.message)
  // 無いモデルを指定したときの実物（codex 0.154.0）
  const api = { message: '{"type":"error","status":400,"error":{"type":"invalid_request_error","message":"The \'x\' model is not supported when using Codex with a ChatGPT account."}}' }
  assert.equal(codexErrorText(api), "The 'x' model is not supported when using Codex with a ChatGPT account.")
  assert.equal(codexErrorText({ message: '{壊れた' }), '{壊れた')
  assert.equal(codexErrorText(null), '')
  assert.equal(codexErrorText({ message: '  ' }), '')
})

test('queuedTurnError: 送った本文のあとのターンが error 付きで終わっていれば、その文', () => {
  const lines = [
    userItem('2026-09-16T09:41:54.769Z', 'PR作成して'),
    event('2026-09-16T09:41:55.000Z', { type: 'task_started' }),
    event('2026-09-16T10:03:31.902Z', { type: 'task_complete', last_agent_message: null, error: LIMIT }),
  ]
  assert.equal(queuedTurnError(lines, 'PR作成して', SINCE), LIMIT.message)
})

test('queuedTurnError: エラーなく終わった・まだ終わっていない・人が止めたときは null', () => {
  const arrived = userItem('2026-09-16T09:41:54.769Z', 'PR作成して')
  assert.equal(queuedTurnError([arrived, event('2026-09-16T09:45:00.000Z', { type: 'task_complete', last_agent_message: 'PR を作りました' })], 'PR作成して', SINCE), null)
  assert.equal(queuedTurnError([arrived, event('2026-09-16T09:42:00.000Z', { type: 'task_started' })], 'PR作成して', SINCE), null)
  assert.equal(queuedTurnError([arrived, event('2026-09-16T09:45:00.000Z', { type: 'turn_aborted' })], 'PR作成して', SINCE), null)
})

test('queuedTurnError: 送る前のターンのエラーは数えない。本文が読んだ範囲に無ければ null', () => {
  // 前のターン（送る前）の上限エラーを、今回の返信の失敗にしない
  const before = [
    userItem('2026-09-16T09:30:00.000Z', 'PR作成して'),
    event('2026-09-16T09:31:00.000Z', { type: 'task_complete', error: LIMIT }),
  ]
  assert.equal(queuedTurnError(before, 'PR作成して', SINCE), null)
  assert.equal(queuedTurnError([event('2026-09-16T10:03:31.902Z', { type: 'task_complete', error: LIMIT })], 'PR作成して', SINCE), null)
})

test('codexTurnErrorReason: エラーの文と、行が残らないことを添える', () => {
  const reason = codexTurnErrorReason(LIMIT.message)
  assert.ok(reason.includes(LIMIT.message))
  assert.match(reason, /記録の行は残りません/)
})
