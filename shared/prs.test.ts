import { test } from 'node:test'
import assert from 'node:assert/strict'
import { checkState, diffStats, githubRepoOf, isPrNumber, isRepoName, knownRepos, parsePrList, parseRequested, pickKnownRepo, prForHeading, prForSession, prFromGh, prHash, prRefsIn, REPLY_PRS_MAX, sortPrs } from './prs.ts'
import type { PrRepo, PrSummary } from './types.ts'

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

test('セッションに紐づく PR は、リポジトリと head のブランチが一致する open な PR（#548）', () => {
  const pr = (number: number, head: string, over: Partial<PrSummary> = {}): PrSummary => ({
    number, title: `t${number}`, author: 'me', head, base: 'main', draft: false, updated_at: '2026-09-30T00:00:00Z', url: '', additions: 0,
    deletions: 0, changed_files: 0, review_decision: '', checks: '', requested: false, ...over,
  })
  const repos: PrRepo[] = [
    { repo: 'Naturalclar/sai', prs: [pr(1, 'feat-a'), pr(2, 'feat-b'), pr(3, 'feat-b', { updated_at: '2026-09-30T01:00:00Z' }), pr(4, 'main', { base: 'main' })] },
    { repo: 'other/repo', prs: [pr(9, 'feat-a')] },
  ]
  const remote = 'https://github.com/naturalclar/SAI'
  assert.deepEqual(prForSession({ remote, branch: 'feat-a' }, repos), { repo: 'Naturalclar/sai', pr: repos[0]!.prs[0] })
  // 同じブランチに 2 本なら新しく動いた方
  assert.equal(prForSession({ remote, branch: 'feat-b' }, repos)?.pr.number, 3)
  // 既定のブランチ（PR の base と同じ）にいるセッションは結ばない
  assert.equal(prForSession({ remote, branch: 'main' }, repos), null)
  // fork の同じ名前のブランチから出た PR は結ばない（#550 のレビュー）
  const forked: PrRepo[] = [{ repo: 'Naturalclar/sai', prs: [pr(5, 'fix-typo', { cross: true })] }]
  assert.equal(prForSession({ remote, branch: 'fix-typo' }, forked), null)
  // ブランチが無い・PR が無い・GitHub 以外・知らないリポジトリ
  assert.equal(prForSession({ remote, branch: '' }, repos), null)
  assert.equal(prForSession({ remote, branch: 'nope' }, repos), null)
  assert.equal(prForSession({ remote: 'https://gitlab.com/Naturalclar/sai', branch: 'feat-a' }, repos), null)
  assert.equal(prForSession({ remote: 'https://github.com/x/y', branch: 'feat-a' }, repos), null)
})

test('prFromGh: reviewDecision が空なら reviews から承認を組み、名前は API に出さない（#793）', () => {
  const head = 'a'.repeat(40)
  const base = { number: 5, reviewDecision: '', headRefOid: head }
  const pr = prFromGh({ ...base, reviews: [{ state: 'APPROVED', authorAssociation: 'MEMBER', author: { login: 'reviewer-a' }, commit: { oid: head } }] })!
  assert.equal(pr.review_decision, 'APPROVED')
  assert.equal(JSON.stringify(pr).includes('reviewer-a'), false, 'レビューした人の名前は PrSummary に入れない')
  assert.equal(prFromGh({ ...base, reviews: [{ state: 'APPROVED', authorAssociation: 'MEMBER', commit: { oid: 'b'.repeat(40) } }] })!.review_decision, 'APPROVED_STALE')
  assert.equal(prFromGh({ ...base, reviews: [{ state: 'APPROVED', authorAssociation: 'NONE' }] })!.review_decision, '', '外部の人の承認は数えない')
  assert.equal(prFromGh({ ...base, reviewDecision: 'REVIEW_REQUIRED', reviews: [{ state: 'APPROVED', authorAssociation: 'MEMBER' }] })!.review_decision, 'REVIEW_REQUIRED', '値があればそのまま')
  assert.equal(prFromGh({ number: 5 })!.review_decision, '', '項目の無い古い形でも落ちない')
})

test('prFromGh: fork のブランチから出た PR（isCrossRepository）に cross を付ける（#550 のレビュー）', () => {
  assert.equal(prFromGh({ number: 1, isCrossRepository: true })?.cross, true)
  assert.equal(prFromGh({ number: 1, isCrossRepository: false })?.cross, undefined)
})

test('prRefsIn: 本文の PR の URL を出てきた順・重複なしで拾う。形の違うものは拾わない（#888）', () => {
  const text = [
    'PR を出しました: https://github.com/owner-a/repo-a/pull/12',
    '前の https://github.com/Owner-A/Repo-A/pull/12 と同じ。別のは <https://github.com/owner-b/repo-b/pull/3>。',
    'issue は https://github.com/owner-a/repo-a/issues/5、番号の無い https://github.com/owner-a/repo-a/pull/、0 番 https://github.com/owner-a/repo-a/pull/0',
    'ほかのホスト https://gitlab.com/owner-a/repo-a/pull/7、続きの付いた https://github.com/owner-a/repo-a/pull/8/files',
  ].join('\n')
  assert.deepEqual(prRefsIn(text, ''), [
    { repo: 'owner-a/repo-a', number: 12 },
    { repo: 'owner-b/repo-b', number: 3 },
    { repo: 'owner-a/repo-a', number: 8 },
  ])
  assert.deepEqual(prRefsIn('', 'owner-a/repo-a'), [])
  const many = Array.from({ length: REPLY_PRS_MAX + 3 }, (_, i) => `https://github.com/owner-a/repo-a/pull/${i + 1}`).join(' ')
  assert.equal(prRefsIn(many, '').length, REPLY_PRS_MAX, '上限で止める')
})

test('prRefsIn: 素の PR #N / #N はリモートのリポジトリの番号として読む。リモートが無ければ読まない（#890）', () => {
  const text = 'PR #4 を出しました（#3 の続き）。PR#5、https://github.com/owner-b/repo-b/pull/6 も。#4 はもう一度。'
  assert.deepEqual(prRefsIn(text, 'owner-a/repo-a'), [
    { repo: 'owner-a/repo-a', number: 4 },
    { repo: 'owner-a/repo-a', number: 3 },
    { repo: 'owner-a/repo-a', number: 5 },
    { repo: 'owner-b/repo-b', number: 6 },
  ])
  assert.deepEqual(prRefsIn(text, ''), [{ repo: 'owner-b/repo-b', number: 6 }], 'リモートが無ければ URL だけ')
  // 前に文字が付いたもの（別のリポジトリの名指し・URL の中・HTML の文字参照）、16 進の色、0 番は読まない
  const noise = 'owner-b/repo-b#7 https://example.com/a#8 &#9; x#10 #abc123 #12ab #0 ## 見出し #14'
  assert.deepEqual(prRefsIn(noise, 'owner-a/repo-a'), [{ repo: 'owner-a/repo-a', number: 14 }])
})

test('セッションの PR: リモートとブランチで結べなければ、返答に出てきた PR の URL から一覧にあるものだけ結ぶ（#888）', () => {
  const open = (number: number, head: string): PrSummary => ({
    number, title: `t${number}`, author: 'me', head, base: 'main', draft: false, updated_at: '2026-09-30T00:00:00Z', url: '', additions: 0,
    deletions: 0, changed_files: 0, review_decision: '', checks: '', requested: false,
  })
  const repos: PrRepo[] = [
    { repo: 'owner-a/repo-a', prs: [open(21, 'feat-x'), open(22, 'feat-y')] },
    { repo: 'owner-b/repo-b', prs: [open(31, 'feat-z')] },
  ]
  // リモートが空・ブランチは外側の main（作業ディレクトリと PR のリポジトリが別の場所）
  const outer = { remote: '', branch: 'main' }
  assert.deepEqual(prForSession({ ...outer, reply_prs: [{ repo: 'OWNER-A/repo-a', number: 22 }] }, repos), { repo: 'owner-a/repo-a', pr: repos[0]!.prs[1] })
  // 一覧に無いリポジトリ・一覧に無い番号は結ばない
  assert.equal(prForSession({ ...outer, reply_prs: [{ repo: 'owner-c/repo-c', number: 22 }] }, repos), null)
  assert.equal(prForSession({ ...outer, reply_prs: [{ repo: 'owner-a/repo-a', number: 99 }] }, repos), null)
  assert.equal(prForSession(outer, repos), null, 'URL が無ければ今までどおり結ばない')
  // 1 つの返答に複数あれば、あとに出てきた方（一覧に無いものは飛ばす）
  assert.equal(prForSession({ ...outer, reply_prs: [{ repo: 'owner-a/repo-a', number: 21 }, { repo: 'owner-b/repo-b', number: 31 }, { repo: 'owner-a/repo-a', number: 99 }] }, repos)?.pr.number, 31)
  // リモートとブランチで結べて、その PR が返答に出てきていればブランチの方（出てこないときは #890 のテスト）
  const matched = prForSession({ remote: 'https://github.com/owner-a/repo-a', branch: 'feat-x', reply_prs: [{ repo: 'owner-a/repo-a', number: 21 }, { repo: 'owner-b/repo-b', number: 31 }] }, repos)
  assert.equal(matched?.pr.number, 21)
})

test('セッションの PR: ブランチの PR が返答に一度も出てこず、返答に一覧の別の PR があれば、そちら（#890）', () => {
  const open = (number: number, head: string): PrSummary => ({
    number, title: `t${number}`, author: 'me', head, base: 'main', draft: false, updated_at: '2026-09-30T00:00:00Z', url: '', additions: 0,
    deletions: 0, changed_files: 0, review_decision: '', checks: '', requested: false,
  })
  const repos: PrRepo[] = [
    { repo: 'owner-a/repo-a', prs: [open(4, 'feat-z'), open(5, 'feat-w')] },
    { repo: 'owner-b/repo-b', prs: [open(31, 'feat-x')] },
  ]
  // 同じ worktree をブランチ feat-z に切り替えた別のセッションのあとで動いた（記録のブランチは feat-z）
  const shared = { remote: 'https://github.com/owner-a/repo-a', branch: 'feat-z' }
  assert.equal(prForSession({ ...shared, reply_prs: [{ repo: 'owner-a/repo-a', number: 4 }, { repo: 'owner-a/repo-a', number: 5 }] }, repos)?.pr.number, 4, 'ブランチの PR が返答に出てきていればブランチの方')
  assert.equal(prForSession({ ...shared, reply_prs: [{ repo: 'Owner-A/Repo-A', number: 4 }] }, repos)?.pr.number, 4, 'リポジトリ名の大文字小文字は見ない')
  assert.equal(prForSession({ ...shared, reply_prs: [{ repo: 'owner-a/repo-a', number: 5 }] }, repos)?.pr.number, 5, '素の番号（リモートの番号）で出てきた別の PR')
  assert.equal(prForSession({ ...shared, reply_prs: [{ repo: 'owner-b/repo-b', number: 31 }] }, repos)?.pr.number, 31, '別のリポジトリの URL で出てきた PR')
  // 返答に一覧の PR が無ければ、今までどおりブランチの PR
  assert.equal(prForSession(shared, repos)?.pr.number, 4)
  assert.equal(prForSession({ ...shared, reply_prs: [{ repo: 'owner-a/repo-a', number: 99 }, { repo: 'owner-c/repo-c', number: 5 }] }, repos)?.pr.number, 4, '一覧に無い番号・リポジトリは数えない')
  // 別のリポジトリの同じ番号は「出てきた」に数えない
  assert.equal(prForSession({ ...shared, reply_prs: [{ repo: 'owner-b/repo-b', number: 4 }, { repo: 'owner-a/repo-a', number: 5 }] }, repos)?.pr.number, 5)
})

test('フィードの見出しの PR: 見出しのブランチで引き、返答の URL はリモートの無いセッションだけ（#888 / #889 のレビュー）', () => {
  const open = (number: number, head: string): PrSummary => ({
    number, title: `t${number}`, author: 'me', head, base: 'main', draft: false, updated_at: '2026-09-30T00:00:00Z', url: '', additions: 0,
    deletions: 0, changed_files: 0, review_decision: '', checks: '', requested: false,
  })
  const repos: PrRepo[] = [{ repo: 'owner-a/repo-a', prs: [open(7, 'feat-new')] }]
  const reply_prs = [{ repo: 'owner-a/repo-a', number: 7 }]
  const withRemote = { remote: 'https://github.com/owner-a/repo-a', reply_prs }
  assert.equal(prForHeading(withRemote, 'feat-new', repos)?.pr.number, 7, '見出しのブランチで結べる')
  assert.equal(prForHeading(withRemote, 'feat-old', repos), null, 'リモートのあるセッションの前のブランチの見出しに、いまの PR を付けない')
  assert.equal(prForHeading(withRemote, 'main', repos), null)
  assert.equal(prForHeading({ remote: '', reply_prs }, 'main', repos)?.pr.number, 7, 'リモートが無ければ返答の URL から')
  assert.equal(prForHeading({ remote: '' }, 'main', repos), null)
})

