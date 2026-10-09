import { test } from 'node:test'
import assert from 'node:assert/strict'
import { countNote, countsTowardSuggest, keyCovered, keyRules, neverSuggested, ruleCovered, rulesKey } from './approvalCounts.ts'
import type { ApprovalLogRow } from './types.ts'

test('rulesKey: 数える鍵は書かれるルールの組。1 つならその表記のまま（前の記録と同じ鍵になる）', () => {
  assert.equal(rulesKey(['Bash(gh pr:*)']), 'Bash(gh pr:*)')
  assert.equal(rulesKey(['Bash(pnpm test:*)', 'Bash(tee:*)']), 'Bash(pnpm test:*) + Bash(tee:*)')
  assert.equal(rulesKey([]), '', 'ルールが無ければ数えない')
  assert.equal(rulesKey(undefined), '')
  assert.deepEqual(keyRules('Bash(pnpm test:*) + Bash(tee:*)'), ['Bash(pnpm test:*)', 'Bash(tee:*)'])
  assert.deepEqual(keyRules(''), [])
})

test('keyCovered / neverSuggested: 組は全部が覆われたときだけ覆われている。Bash(cd:*) だけの鍵は勧めない（#705）', () => {
  const key = 'Bash(pnpm test:*) + Bash(tee:*)'
  assert.equal(keyCovered(key, ['Bash(pnpm:*)']), false, '片方だけ')
  assert.equal(keyCovered(key, ['Bash(pnpm:*)', 'Bash(tee:*)']), true)
  assert.equal(neverSuggested('Bash(cd:*)'), true, '前の記録に残っている効かないルール')
  assert.equal(neverSuggested('Bash(cd:*) + Bash(pnpm test:*)'), false)
  assert.equal(neverSuggested('Bash(gh pr:*)'), false)
})

test('countsTowardSuggest: 人が許可した・ルールがある・cwd が分かる行だけ', () => {
  const row: ApprovalLogRow = { ts: '2026-10-01T00:00:00.000Z', id: 'S@r', cwd: '/w', tool: 'Bash', rule: 'Bash(gh pr:*)', by: 'human', behavior: 'allow', remember: false, waited_s: 3 }
  assert.equal(countsTowardSuggest(row), true)
  assert.equal(countsTowardSuggest({ ...row, by: 'jev' }), false, 'Jev の自動は人の回数に数えない')
  assert.equal(countsTowardSuggest({ ...row, behavior: 'deny' }), false)
  assert.equal(countsTowardSuggest({ ...row, rule: '' }), false)
  assert.equal(countsTowardSuggest({ ...row, cwd: '' }), false)
})

test('countNote: 2 回目から数字を出し、勧める回数からは一言添える', () => {
  assert.equal(countNote({ count: 1 }, 'Bash(gh pr:*)'), '')
  assert.equal(countNote({}, 'Bash(gh pr:*)'), '')
  assert.equal(countNote({ count: 2 }, 'Bash(gh pr:*)'), '2 回目の許可（Bash(gh pr:*)）')
  assert.equal(countNote({ count: 3, suggest: true }, 'Bash(gh pr:*)'), '3 回目の許可（Bash(gh pr:*)）。「常に許可」にすると、下のルールの範囲は聞かれなくなります')
})

test('ruleCovered: 同じ表記・より広いルール・別の書き方は覆っている。狭いルールや別のコマンドは覆っていない（#621 のレビュー）', () => {
  const rule = 'Bash(gh pr:*)'
  for (const allowed of ['Bash(gh pr:*)', 'Bash(gh:*)', 'Bash(gh pr *)', 'Bash(gh *)', 'Bash']) assert.equal(ruleCovered(rule, [allowed]), true, allowed)
  for (const allowed of ['Bash(gh pr create:*)', 'Bash(g:*)', 'Bash(git:*)', 'Bash(gh pr view)', 'mcp__github__create_issue']) assert.equal(ruleCovered(rule, [allowed]), false, allowed)
  assert.equal(ruleCovered('mcp__github__create_issue', ['mcp__github__create_issue']), true)
  assert.equal(ruleCovered('mcp__github__create_issue', ['Bash']), false)
})
