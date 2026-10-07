import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { PrSummary } from './types.ts'
import { HOLDING_ISSUES_MAX, holdingLabel, holdingOf, issueNumbers, prOfBranch } from './holding.ts'

const pr = (over: Partial<PrSummary> = {}): PrSummary => ({
  number: 9101, title: '在庫の絞り込みを直す (#9100)', author: 'me', head: 'issue-9100-stock-filter', base: 'main', draft: false, updated_at: '', url: '',
  additions: 0, deletions: 0, changed_files: 0, review_decision: '', checks: 'success', requested: false, ...over,
})

test('prOfBranch: ブランチから出ている open な PR。fork の同じ名前のブランチ・引けていない一覧・空のブランチは結ばない（#727）', () => {
  const list = [pr({ number: 1, head: 'other' }), pr({ number: 2, cross: true }), pr({ number: 3 })]
  assert.equal(prOfBranch(list, 'issue-9100-stock-filter')?.number, 3)
  assert.equal(prOfBranch(list, 'main'), undefined)
  assert.equal(prOfBranch(null, 'issue-9100-stock-filter'), undefined)
  assert.equal(prOfBranch(undefined, 'issue-9100-stock-filter'), undefined)
  assert.equal(prOfBranch(list, ''), undefined)
})

test('issueNumbers: ブランチ名・PR の題名・届いている依頼の 1 行目から引けた番号だけ。当て推量で埋めない（#727）', () => {
  assert.deepEqual(issueNumbers('issue-9100-stock-filter', undefined, []), [9100])
  assert.deepEqual(issueNumbers('fix/issue_12', undefined, []), [12])
  assert.deepEqual(issueNumbers('dev-worktree-a', undefined, []), [], '番号の無いブランチ名からは引かない')
  assert.deepEqual(issueNumbers('release-2026', undefined, []), [], 'issue と書いていない数字は拾わない')
  assert.deepEqual(issueNumbers('dev-worktree-a', pr({ number: 9101, title: '絞り込みを直す (#9100) #9101' }), []), [9100], 'PR 自身の番号は issue に数えない')
  assert.deepEqual(issueNumbers('dev-worktree-a', undefined, ['#9200 に着手してください。\n関連: #1 #2 #3']), [9200], '依頼は 1 行目だけ（本文の途中の関連の番号まで拾わない）')
  assert.deepEqual(issueNumbers('issue-9100-x', pr(), ['#9100 の続きです', '#9300 も見て']), [9100, 9300], '重複は 1 つ。出てきた順')
  assert.equal(issueNumbers('issue-1-x', pr({ title: 'まとめて直す (#2 #3 #4 #5)' }), []).length, HOLDING_ISSUES_MAX)
  // PR の番号・別の PR・色の指定などを issue と呼ばない（#727 のレビュー）
  assert.deepEqual(issueNumbers('dev-worktree-a', undefined, ['PR #9134 をレビューしてください']), [], '依頼の PR の番号は issue ではない')
  assert.deepEqual(issueNumbers('dev-worktree-a', undefined, ['色を #123456 にして', '見て。#9 も']), [], '行の頭でも issue とも書いていない番号は拾わない')
  assert.deepEqual(issueNumbers('dev-worktree-a', undefined, ['issue #9200 を調べて', '  #9300 に着手してください。']), [9200, 9300])
  assert.deepEqual(issueNumbers('dev-worktree-a', pr({ number: 9129, title: '預かる (#9127 の案 A) の続き。#9128 の上に積む' }), []), [9127], '題名は括弧の中だけ（括弧の外は別の PR のことが多い）')
  assert.deepEqual(issueNumbers('dev-worktree-a', pr({ title: '全角の括弧（#9100）' }), []), [9100])
  assert.deepEqual(issueNumbers('dev-worktree-a', pr({ title: '直す (see PR #9700)（PR #9728 の続き）(#9100)' }), []), [9100], '括弧の中でも PR の番号は issue ではない')
})

test('holdingOf / holdingLabel: 分かるものだけを短い印にする。本文・題名は載せない（#727）', () => {
  const working = holdingOf({ branch: 'issue-9100-stock-filter', prs: [pr()], asks: ['#9100 に着手してください。\n長い説明'], occupied: true })
  assert.deepEqual(working, { pr: { number: 9101, checks: 'success' }, issues: [9100], asked: 1 })
  assert.equal(holdingLabel(working), ' PR #9101（CI 緑） issue #9100 頼まれ中 1 件')
  assert.doesNotMatch(holdingLabel(working), /在庫|長い説明/)
  // 空き: 処理中でも待ちでもなく、頼まれてもいない
  const idle = holdingOf({ branch: 'main', prs: [pr()], asks: [], occupied: false })
  assert.deepEqual(idle, { free: true })
  assert.equal(holdingLabel(idle), ' （空き）')
  assert.equal(holdingOf({ branch: 'main', prs: [], asks: ['見て'], occupied: false }).free, undefined, '頼まれて未完のものがあれば空きではない')
  assert.deepEqual(holdingOf({ branch: 'main', prs: [], asks: [], occupied: false, sendable: false }), {}, '頼めない相手（別のマシン・送れないセッション）に空きは付けない')
  // CI の状態と下書き。チェックが無い PR は番号だけ
  assert.equal(holdingLabel({ pr: { number: 7, checks: 'failure' } }), ' PR #7（CI 赤）')
  assert.equal(holdingLabel({ pr: { number: 7, checks: 'pending', draft: true } }), ' PR #7（下書き・CI 待ち）')
  assert.equal(holdingLabel({ pr: { number: 7, checks: '' } }), ' PR #7')
  assert.equal(holdingLabel({ issues: [1, 2] }), ' issue #1, #2')
  // 何も分からなければ何も足さない（PR を引けていない・番号の無いブランチ・処理中）
  assert.deepEqual(holdingOf({ branch: 'dev-worktree-a', prs: null, asks: [], occupied: true }), {})
  assert.equal(holdingLabel({}), '')
})
