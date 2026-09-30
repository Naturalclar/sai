import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { ManagerDraft } from './types.ts'
import { MANAGER_DRAFT_TTL_MS, liveManagerDraft } from './managerDraft.ts'

const NOW = Date.parse('2026-10-01T12:00:00Z')
const draft = (over: Partial<ManagerDraft> = {}): ManagerDraft => ({ text: 'CI を見て', from: 'このマシン', at: NOW - 60_000, base_text: '実装して', base_turns: 3, busy: false, ...over })

test('liveManagerDraft: 置いたときの入力のままなら出す。人の入力が来たら・24 時間を過ぎたら出さない（#565）', () => {
  assert.ok(liveManagerDraft(draft(), { last_user_text: '実装して', turns: 3, last_kind: 'turn' }, NOW))
  assert.equal(liveManagerDraft(draft(), { last_user_text: '自分で打った', turns: 3, last_kind: 'other' }, NOW), undefined)
  assert.equal(liveManagerDraft(draft({ at: NOW - MANAGER_DRAFT_TTL_MS }), { last_user_text: '実装して', turns: 3, last_kind: 'turn' }, NOW), undefined)
  assert.equal(liveManagerDraft(draft({ text: '  ' }), { last_user_text: '実装して', turns: 3 }, NOW), undefined)
  assert.equal(liveManagerDraft(undefined, { last_user_text: '実装して', turns: 3 }, NOW), undefined)
})

test('liveManagerDraft: 処理中に置いた案は、回っていたターンが終わっただけでは消さない（#586 のレビュー）', () => {
  // Claude: 回っていたターンの入力は入力の行で先に届いているので、ターン完了の行も同じ入力を持つ
  assert.ok(liveManagerDraft(draft({ busy: true }), { last_user_text: '実装して', turns: 4, last_kind: 'turn' }, NOW))
  // Codex: 入力の行が無く、回っていたターンの入力はターン完了の行で初めて届く
  assert.ok(liveManagerDraft(draft({ busy: true, base_text: '前の指示' }), { last_user_text: '実装して', turns: 4, last_kind: 'turn' }, NOW))
  // その次のターンが終われば、人が送ったということ
  assert.equal(liveManagerDraft(draft({ busy: true, base_text: '前の指示' }), { last_user_text: '次の指示', turns: 5, last_kind: 'turn' }, NOW), undefined)
  // 処理中でなかったのにターンが増えて入力が変わったら、人が送った
  assert.equal(liveManagerDraft(draft({ base_text: '前の指示' }), { last_user_text: '実装して', turns: 4, last_kind: 'turn' }, NOW), undefined)
})
