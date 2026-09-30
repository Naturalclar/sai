import { test } from 'node:test'
import assert from 'node:assert/strict'
import { agoLabel, checkLabel, filterRepos, requestedCount, reviewLabel } from './prLabels.ts'
import type { PrRepo, PrSummary } from '../../shared/types.ts'

test('checkLabel: 通った・落ちた・走っている。チェックが無ければ出さない', () => {
  assert.equal(checkLabel('success')?.mark, '✓')
  assert.equal(checkLabel('failure')?.mark, '✗')
  assert.equal(checkLabel('pending')?.mark, '●')
  assert.equal(checkLabel(''), null)
})

test('reviewLabel: 知らない値は空', () => {
  assert.equal(reviewLabel('APPROVED'), '承認済み')
  assert.equal(reviewLabel('CHANGES_REQUESTED'), '修正の依頼あり')
  assert.equal(reviewLabel('REVIEW_REQUIRED'), 'レビュー待ち')
  assert.equal(reviewLabel(''), '')
  assert.equal(reviewLabel('SOMETHING'), '')
})

test('agoLabel: 分・時間・日で丸める。読めない時刻と now が無いときは空', () => {
  const now = Date.parse('2026-09-30T12:00:00Z')
  assert.equal(agoLabel('2026-09-30T11:59:40Z', now), 'いま')
  assert.equal(agoLabel('2026-09-30T11:55:00Z', now), '5 分前')
  assert.equal(agoLabel('2026-09-30T09:00:00Z', now), '3 時間前')
  assert.equal(agoLabel('2026-09-28T12:00:00Z', now), '2 日前')
  assert.equal(agoLabel('bad', now), '')
  assert.equal(agoLabel('2026-09-30T11:55:00Z', 0), '')
})

const pr = (number: number, requested: boolean): PrSummary => ({
  number,
  title: '',
  author: '',
  head: '',
  base: '',
  draft: false,
  updated_at: '',
  url: '',
  additions: 0,
  deletions: 0,
  changed_files: 0,
  review_decision: '',
  checks: '',
  requested,
})

test('filterRepos / requestedCount: 頼まれているものだけにすると、空になったリポジトリは落ちる', () => {
  const repos: PrRepo[] = [
    { repo: 'a/one', prs: [pr(1, true), pr(2, false)] },
    { repo: 'a/two', prs: [pr(3, false)] },
    { repo: 'a/err', prs: [], error: 'x' },
  ]
  assert.equal(filterRepos(repos, false).length, 3)
  assert.deepEqual(filterRepos(repos, true).map((r) => [r.repo, r.prs.map((p) => p.number)]), [['a/one', [1]]])
  assert.equal(requestedCount(repos), 1)
})
