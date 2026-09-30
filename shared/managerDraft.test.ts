import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { FeedRow, ManagerDraft } from './types.ts'
import { MANAGER_DRAFT_TTL_MS, liveManagerDraft } from './managerDraft.ts'

const NOW = Date.parse('2026-10-01T12:00:00Z')
const AT = NOW - 10 * 60_000
const draft = (over: Partial<ManagerDraft> = {}): ManagerDraft => ({ text: 'CI を見て', from: 'このマシン', at: AT, busy: false, ...over })
const iso = (ms: number) => new Date(ms).toISOString()
const turn = (ms: number, user_text = '実装して'): FeedRow => ({ ts: iso(ms), event: 'Stop', user_text, text: 'やりました' }) as FeedRow
const input = (ms: number, user_text = '続けて'): FeedRow => ({ ts: iso(ms), event: 'UserPromptSubmit', user_text, text: '' }) as FeedRow
const idle = (ms: number): FeedRow => ({ ts: iso(ms), event: 'Notification', text: 'Claude is waiting for your input' }) as FeedRow

test('liveManagerDraft: 置いたあとに人の入力が来ていなければ出す。入力が来たら・24 時間を過ぎたら出さない（#565）', () => {
  assert.ok(liveManagerDraft(draft(), [turn(AT - 60_000), input(AT - 120_000)], NOW), '置く前の行は見ない')
  assert.equal(liveManagerDraft(draft(), [input(AT + 60_000)], NOW), undefined, '入力の行が来た')
  assert.equal(liveManagerDraft(draft(), [turn(AT - 60_000, '続けて'), input(AT + 60_000, '続けて')], NOW), undefined, '同じ文面を送り直しても入力は入力')
  assert.equal(liveManagerDraft(draft(), [turn(AT + 60_000)], NOW), undefined, '回っていなかったのにターンが終わった＝人が送った（Codex）')
  assert.ok(liveManagerDraft(draft(), [idle(AT + 60_000)], NOW), '入力待ちの通知は入力ではない')
  assert.equal(liveManagerDraft(draft({ at: NOW - MANAGER_DRAFT_TTL_MS }), [], NOW), undefined)
  assert.equal(liveManagerDraft(draft({ text: '  ' }), [], NOW), undefined)
  assert.equal(liveManagerDraft(undefined, [], NOW), undefined)
})

test('liveManagerDraft: 処理中に置いた案は、回っていたターンが終わっただけでは消さない（#586 のレビュー）', () => {
  assert.ok(liveManagerDraft(draft({ busy: true }), [turn(AT + 60_000), idle(AT + 120_000)], NOW), '回っていたターンの終わり（とその後の通知）')
  assert.equal(liveManagerDraft(draft({ busy: true }), [turn(AT + 60_000), turn(AT + 120_000)], NOW), undefined, '2 本目のターンは人が送ったもの')
  assert.equal(liveManagerDraft(draft({ busy: true }), [turn(AT + 60_000), input(AT + 90_000)], NOW), undefined, '入力の行が来れば回っていても入力')
})

test('liveManagerDraft: 自分で起きたターン（user_text の無いターン完了）は人の入力と数えない。フックが Stop だけでも入力は分かる（#586 のレビュー）', () => {
  assert.ok(liveManagerDraft(draft(), [turn(AT + 60_000, '')], NOW), 'バックグラウンドのタスクが終わって起きたターン')
  assert.ok(liveManagerDraft(draft({ busy: true }), [turn(AT + 60_000), turn(AT + 120_000, '')], NOW))
  assert.equal(liveManagerDraft(draft(), [turn(AT + 60_000, '別の指示')], NOW), undefined, '入力の行が無くても（Stop だけのフック）、入力の載ったターン完了で消す')
})
