import { test } from 'node:test'
import assert from 'node:assert/strict'
import { countedRule, countNote, countsTowardSuggest, ruleCovered } from './approvalCounts.ts'
import type { ApprovalLogRow } from './types.ts'

test('countedRule: 「常に許可」が出せる許可だけ数える（Claude で、ルールが作れるツール）', () => {
  assert.equal(countedRule({ tool_name: 'Bash', input: { command: 'gh pr create --base main' } }), 'Bash(gh pr:*)')
  assert.equal(countedRule({ tool_name: 'mcp__github__create_issue', input: {} }), 'mcp__github__create_issue')
  assert.equal(countedRule({ tool_name: 'Edit', input: { file_path: '/x' } }), '', 'ファイル系はルールが無い')
  assert.equal(countedRule({ tool_name: 'AskUserQuestion', input: {} }), '', '質問は数えない')
  assert.equal(countedRule({ tool_name: 'Bash', input: { command: 'gh pr view' }, agent: 'codex' }), '', 'Codex には「常に許可」が無い')
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
  assert.equal(countNote({ count: 3, suggest: true }, 'Bash(gh pr:*)'), '3 回目の許可（Bash(gh pr:*)）。「常に許可」にすると、この形は聞かれなくなります')
})

test('ruleCovered: 同じ表記・より広いルール・別の書き方は覆っている。狭いルールや別のコマンドは覆っていない（#621 のレビュー）', () => {
  const rule = 'Bash(gh pr:*)'
  for (const allowed of ['Bash(gh pr:*)', 'Bash(gh:*)', 'Bash(gh pr *)', 'Bash(gh *)', 'Bash']) assert.equal(ruleCovered(rule, [allowed]), true, allowed)
  for (const allowed of ['Bash(gh pr create:*)', 'Bash(g:*)', 'Bash(git:*)', 'Bash(gh pr view)', 'mcp__github__create_issue']) assert.equal(ruleCovered(rule, [allowed]), false, allowed)
  assert.equal(ruleCovered('mcp__github__create_issue', ['mcp__github__create_issue']), true)
  assert.equal(ruleCovered('mcp__github__create_issue', ['Bash']), false)
})
