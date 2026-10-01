import { test } from 'node:test'
import assert from 'node:assert/strict'
import { STOP_MISSING_AFTER_MS, stopMissing, stopMissingCandidate } from './stopMissing.ts'

const INPUT = '2026-10-01T11:34:40+09:00'
const at = Date.parse(INPUT)
const NOW = at + 30 * 60_000
const s = { agent: 'claude' as const, last_kind: 'resume' as const, end: INPUT, last_user_ts: INPUT }
const closedAt = new Date(at + 11 * 60_000).toISOString()

test('stopMissing: 最後の行が人の入力のまま、transcript のターンが閉じて時間が過ぎたときだけ印を出す（#614）', () => {
  assert.equal(stopMissing(s, { busy: false, closedAt, now: NOW }), true)
  assert.equal(stopMissing(s, { busy: true, closedAt, now: NOW }), false, 'SAI が回している')
  assert.equal(stopMissing(s, { busy: false, closedAt: '', now: NOW }), false, '閉じていない・読めない（回っている・Esc で止めた）は分からないので出さない')
  assert.equal(stopMissing(s, { busy: false, closedAt: new Date(at - 60_000).toISOString(), now: NOW }), false, '閉じたのは前のターン')
  const justClosed = Date.parse(closedAt) + STOP_MISSING_AFTER_MS - 1
  assert.equal(stopMissing(s, { busy: false, closedAt, now: justClosed }), false, '閉じた直後はフックの行を待つ')
  assert.equal(stopMissing(s, { busy: false, closedAt, now: justClosed + 1 }), true)
})

test('stopMissingCandidate: Claude の入力の載った入力の行が最後のときだけ', () => {
  assert.equal(stopMissingCandidate(s, NOW), true)
  assert.equal(stopMissingCandidate({ ...s, last_kind: 'turn' }, NOW), false, 'ターン完了が来ている')
  assert.equal(stopMissingCandidate({ ...s, last_kind: 'waiting' }, NOW), false, '待ち')
  assert.equal(stopMissingCandidate({ ...s, agent: 'codex' }, NOW), false)
  assert.equal(stopMissingCandidate({ ...s, last_user_ts: '2026-10-01T11:00:00+09:00' }, NOW), false, '最後の行は入力の無い合図（待ちの解消）')
  assert.equal(stopMissingCandidate(s, at + STOP_MISSING_AFTER_MS - 1), false)
})
