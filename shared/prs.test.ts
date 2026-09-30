import { test } from 'node:test'
import assert from 'node:assert/strict'
import { checkState, diffStats, githubRepoOf, isPrNumber, isRepoName, knownRepos, parsePrList, parseRequested, pickKnownRepo, prFromGh, prHash, sortPrs } from './prs.ts'
import type { PrSummary } from './types.ts'

test('isRepoName: owner/repo だけを通し、フラグや .. や空白は断る', () => {
  assert.equal(isRepoName('Naturalclar/sai'), true)
  assert.equal(isRepoName('a-b/c.d_e'), true)
  assert.equal(isRepoName('-x/y'), false)
  assert.equal(isRepoName('a/../b'), false)
  assert.equal(isRepoName('a/b/c'), false)
  assert.equal(isRepoName('a b/c'), false)
  assert.equal(isRepoName('sai'), false)
})

test('isPrNumber: 数字だけ。0 と先頭 0 と長すぎるものは断る', () => {
  assert.equal(isPrNumber('524'), true)
  assert.equal(isPrNumber('0'), false)
  assert.equal(isPrNumber('012'), false)
  assert.equal(isPrNumber('1234567890'), false)
  assert.equal(isPrNumber('5a'), false)
})

test('githubRepoOf: GitHub の remote だけ owner/repo にする', () => {
  assert.equal(githubRepoOf('https://github.com/Naturalclar/sai'), 'Naturalclar/sai')
  assert.equal(githubRepoOf('git@github.com:Naturalclar/sai.git'), 'Naturalclar/sai')
  assert.equal(githubRepoOf('https://gitlab.com/a/b'), '')
  assert.equal(githubRepoOf(''), '')
  assert.equal(githubRepoOf(undefined), '')
})

test('knownRepos: 出てきた順のまま重複を落とす。GitHub 以外と remote の無いものは入れない', () => {
  const repos = knownRepos([
    { remote: 'https://github.com/a/one' },
    { remote: 'https://gitlab.com/a/two' },
    {},
    { remote: 'git@github.com:a/one.git' },
    { remote: 'https://github.com/b/three' },
  ])
  assert.deepEqual(repos, ['a/one', 'b/three'])
})

test('knownRepos: 大文字小文字だけが違う書き方は 1 つにまとめ、最初の書き方を残す（#533 のレビュー）', () => {
  const repos = knownRepos([
    { remote: 'https://github.com/Naturalclar/sai' },
    { remote: 'git@github.com:naturalclar/sai.git' },
    { remote: 'https://github.com/NATURALCLAR/SAI' },
  ])
  assert.deepEqual(repos, ['Naturalclar/sai'], '同じリポジトリの PR を 2 回並べない・gh を 2 倍叩かない')
  assert.equal(pickKnownRepo(repos, 'naturalclar/sai'), 'Naturalclar/sai', 'URL に書かれた形からも同じ 1 つを引ける')
})

test('pickKnownRepo: 知っているものだけを、知っている形で返す（大文字小文字は見ない）', () => {
  assert.equal(pickKnownRepo(['Naturalclar/sai'], 'naturalclar/SAI'), 'Naturalclar/sai')
  assert.equal(pickKnownRepo(['Naturalclar/sai'], 'someone/else'), '')
})

test('checkState: 落ちたものが 1 つでもあれば failure、終わっていなければ pending', () => {
  assert.equal(checkState([]), '')
  assert.equal(checkState(undefined), '')
  assert.equal(checkState([{ status: 'COMPLETED', conclusion: 'SUCCESS' }, { status: 'COMPLETED', conclusion: 'SKIPPED' }]), 'success')
  assert.equal(checkState([{ status: 'COMPLETED', conclusion: 'SUCCESS' }, { status: 'IN_PROGRESS', conclusion: '' }]), 'pending')
  assert.equal(checkState([{ status: 'IN_PROGRESS', conclusion: '' }, { status: 'COMPLETED', conclusion: 'FAILURE' }]), 'failure')
  // 古い commit status は state だけを持つ
  assert.equal(checkState([{ state: 'PENDING' }]), 'pending')
  assert.equal(checkState([{ state: 'ERROR' }]), 'failure')
  assert.equal(checkState([{ state: 'SUCCESS' }]), 'success')
})

test('prFromGh / parsePrList: gh の JSON を読む。番号の無いものは落とし、壊れた出力は null', () => {
  const pr = prFromGh({
    number: 12,
    title: 't',
    author: { login: 'alice' },
    headRefName: 'feat',
    baseRefName: 'main',
    isDraft: true,
    updatedAt: '2026-09-30T00:00:00Z',
    url: 'https://github.com/a/b/pull/12',
    additions: 3,
    deletions: 1,
    changedFiles: 2,
    reviewDecision: 'REVIEW_REQUIRED',
    statusCheckRollup: [{ status: 'COMPLETED', conclusion: 'SUCCESS' }],
  })
  assert.deepEqual(pr, {
    number: 12,
    title: 't',
    author: 'alice',
    head: 'feat',
    base: 'main',
    draft: true,
    updated_at: '2026-09-30T00:00:00Z',
    url: 'https://github.com/a/b/pull/12',
    additions: 3,
    deletions: 1,
    changed_files: 2,
    review_decision: 'REVIEW_REQUIRED',
    checks: 'success',
    requested: false,
  })
  assert.deepEqual(parsePrList('[{"number":1},{"title":"no number"}]')?.map((p) => p.number), [1])
  assert.deepEqual(parsePrList('[]'), [])
  assert.equal(parsePrList('not json'), null)
  assert.equal(parsePrList('{}'), null)
})

test('parseRequested: 頼まれている番号の集合。読めなければ空', () => {
  assert.deepEqual([...parseRequested('[{"number":3},{"number":5}]')], [3, 5])
  assert.equal(parseRequested('oops').size, 0)
})

const pr = (n: number, updated: string, requested = false): PrSummary => ({
  number: n,
  title: '',
  author: '',
  head: '',
  base: '',
  draft: false,
  updated_at: updated,
  url: '',
  additions: 0,
  deletions: 0,
  changed_files: 0,
  review_decision: '',
  checks: '',
  requested,
})

test('sortPrs: 頼まれているものを先に、その中と残りは新しく動いた順', () => {
  const sorted = sortPrs([pr(1, '2026-09-01'), pr(2, '2026-09-03'), pr(3, '2026-08-01', true), pr(4, '2026-09-02', true)])
  assert.deepEqual(sorted.map((p) => p.number), [4, 3, 2, 1])
})

test('diffStats: 本文から追加・削除を数え、新しいファイル・リネームも読む', () => {
  const patch = [
    'diff --git a/a.ts b/a.ts',
    'index 1..2 100644',
    '--- a/a.ts',
    '+++ b/a.ts',
    '@@ -1,2 +1,2 @@',
    ' keep',
    '-old',
    '+new',
    '+more',
    'diff --git a/n.ts b/n.ts',
    'new file mode 100644',
    '--- /dev/null',
    '+++ b/n.ts',
    '@@ -0,0 +1 @@',
    '+x',
    'diff --git a/o.ts b/r.ts',
    'similarity index 100%',
    'rename from o.ts',
    'rename to r.ts',
  ].join('\n')
  assert.deepEqual(diffStats(patch), [
    { path: 'a.ts', status: 'modified', added: 2, removed: 1 },
    { path: 'n.ts', status: 'added', added: 1, removed: 0 },
    { path: 'r.ts', old_path: 'o.ts', status: 'renamed', added: 0, removed: 0 },
  ])
})

test('prHash: 1 本の画面の hash', () => {
  assert.equal(prHash('a/b', 7), '#/pr/a/b/7')
})
