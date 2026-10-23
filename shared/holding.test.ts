import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { PrSummary } from './types.ts'
import { HOLDING_ISSUES_MAX, SEEN_CONTEXT_FACTOR, SEEN_CONTEXT_MIN_TOKENS, WHY_LABEL, grownSinceSeen, holdingLabel, holdingOf, issueNumbers, notFreeWhy, prOfBranch, startRefusal } from './holding.ts'

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
  const working = holdingOf({ branch: 'issue-9100-stock-filter', prs: [pr()], asks: ['#9100 に着手してください。\n長い説明'], occupied: 'busy' })
  assert.deepEqual(working, { pr: { number: 9101, checks: 'success' }, issues: [9100], asked: 1, why: 'busy' })
  assert.equal(holdingLabel(working), ' PR #9101（CI 緑） issue #9100 頼まれ中 1 件')
  assert.doesNotMatch(holdingLabel(working), /在庫|長い説明/)
  // 空き: 処理中でも待ちでもなく、頼まれてもいない
  const idle = holdingOf({ branch: 'main', prs: [pr()], asks: [], occupied: '' })
  assert.deepEqual(idle, { free: true })
  assert.equal(holdingLabel(idle), ' （空き）')
  assert.equal(holdingOf({ branch: 'main', prs: [], asks: ['見て'], occupied: '' }).free, undefined, '頼まれて未完のものがあれば空きではない')
  assert.deepEqual(holdingOf({ branch: 'main', prs: [], asks: [], occupied: '', sendable: false }), {}, '頼めない相手（別のマシン・送れないセッション）に空きは付けない')
  // CI の状態と下書き。チェックが無い PR は番号だけ
  assert.equal(holdingLabel({ pr: { number: 7, checks: 'failure' } }), ' PR #7（CI 赤）')
  assert.equal(holdingLabel({ pr: { number: 7, checks: 'pending', draft: true } }), ' PR #7（下書き・CI 待ち）')
  assert.equal(holdingLabel({ pr: { number: 7, checks: '' } }), ' PR #7')
  assert.equal(holdingLabel({ issues: [1, 2] }), ' issue #1, #2')
  // 何も分からなければ何も足さない（PR を引けていない・番号の無いブランチ・処理中）
  assert.deepEqual(holdingOf({ branch: 'dev-worktree-a', prs: null, asks: [], occupied: 'busy' }), { why: 'busy' })
  assert.equal(holdingLabel({ why: 'busy' }), '', '「（処理中）」は行にもう出ているので重ねない')
  assert.equal(holdingLabel({}), '')
})

// ---- #795: 「空き」を狭める・理由を出す・送る時点の確かめの材料

test('notFreeWhy: 作りかけがあれば空きにしない。マージ済みのブランチが残っているだけ・git でない場所は空き。分からなければ空きにしない（#795）', () => {
  const of = (over: Partial<Parameters<typeof notFreeWhy>[0]>) => notFreeWhy({ occupied: '', asked: 0, inPr: false, ...over })
  assert.equal(of({}), '', '作業の状態を見ない相手（省いたとき）は今までどおり')
  assert.equal(of({ work: 'clean' }), '', 'マージ済みのブランチが残っているだけ')
  assert.equal(of({ work: 'none' }), '', 'git のリポジトリでない')
  assert.equal(of({ work: 'dirty' }), 'dirty')
  assert.equal(of({ work: 'dirty', inPr: true }), 'dirty', 'PR が出ていても、コミットしていない変更があれば空きではない')
  assert.equal(of({ work: 'ahead' }), 'unpushed')
  assert.equal(of({ work: 'ahead', inPr: true }), 'pr', 'いまのブランチの PR がマージ前なら空きではない（#816）')
  assert.equal(of({ work: 'clean', inPr: true }), 'pr', '作業の状態に関わらず、open な PR があれば空きではない（#816）')
  assert.equal(of({ inPr: true }), 'pr', '作業の状態を見ない相手でも、open な PR があれば空きではない（#816）')
  assert.equal(of({ work: 'unknown' }), 'unknown', 'git が読めないときは空きにしない')
  assert.equal(of({ work: 'ahead', prUnknown: true }), 'pr_unknown', 'PR の状態を gh で確かめ切れなければ、空きにしないまま理由を分ける（#828）')
  assert.equal(of({ work: 'ahead', prUnknown: true, inPr: true }), 'pr', '分かっている open な PR が先')
  assert.equal(of({ work: 'dirty', prUnknown: true }), 'dirty', '未コミットの変更が先')
  assert.equal(of({ work: 'clean', prUnknown: true }), '', '作りかけが無ければ PR を確かめる要が無い')
  // 理由は最初に当たった 1 つ（回っているターン → 頼まれ中 → 作りかけ）
  assert.equal(of({ occupied: 'terminal', asked: 1, work: 'dirty' }), 'terminal')
  assert.equal(of({ asked: 1, work: 'dirty' }), 'asked')
})

test('holdingOf / holdingLabel: 空きでない相手に短い理由を 1 つ付ける。頼めない相手には付けない（#795）', () => {
  const dirty = holdingOf({ branch: 'issue-9100-stock-filter', prs: [pr()], asks: [], occupied: '', work: 'dirty' })
  assert.deepEqual(dirty, { pr: { number: 9101, checks: 'success' }, issues: [9100], why: 'dirty' })
  assert.equal(holdingLabel(dirty), ' PR #9101（CI 緑） issue #9100 （未コミットの変更）')
  assert.deepEqual(holdingOf({ branch: 'dev-worktree-a', prs: [], asks: [], occupied: '', work: 'ahead' }), { why: 'unpushed' })
  assert.deepEqual(holdingOf({ branch: 'issue-9100-stock-filter', prs: [pr()], asks: [], occupied: '', work: 'ahead' }).why, 'pr', 'PR がマージ前（#816）')
  assert.equal(holdingLabel(holdingOf({ branch: 'issue-9100-stock-filter', prs: [pr()], asks: [], occupied: '', work: 'ahead' })), ' PR #9101（CI 緑） issue #9100 （PR がマージ前）')
  assert.deepEqual(holdingOf({ branch: 'issue-9100-stock-filter', prs: [], asks: [], occupied: '', work: 'clean' }).free, true, 'PR がマージされた（open な PR に無い）ブランチは空き')
  assert.deepEqual(holdingOf({ branch: 'issue-9100-stock-filter', prs: null, asks: [], occupied: '', work: 'ahead' }).why, 'unpushed', 'PR の一覧が引けなければ、PR が無いのと同じ扱い（空きにしない）')
  assert.equal(holdingLabel({ why: 'terminal' }), ' （端末で作業中）')
  assert.equal(holdingLabel({ asked: 1, why: 'asked' }), ' 頼まれ中 1 件', '「頼まれ中 N 件」と重ねない')
  assert.deepEqual(holdingOf({ branch: 'main', prs: [], asks: [], occupied: 'terminal', sendable: false }), {}, '頼めない相手には理由も付けない')
  // 1 行を長くしない（#688）: 理由は短い語 1 つ
  for (const label of Object.values(WHY_LABEL)) assert.ok(label.length <= 10, label)
})

test('startRefusal: 送らなかった理由を 1 つ返す。別のリポジトリの相手には理由の中身を出さない（#795）', () => {
  assert.equal(startRefusal('terminal'), '相手は空きではないので、着手の依頼は送りませんでした（端末で作業中）。相手には何も届いていません。sai_sessions を引き直して空きの相手を選ぶか、人に確かめてください')
  const hidden = startRefusal('dirty', true)
  assert.doesNotMatch(hidden, /未コミット|変更/)
  assert.match(hidden, /別のリポジトリの相手の理由は出しません/)
  // PR の状態を確かめ切れなかった（#828）: 送り直せば通ることがあると言う。別のリポジトリの相手には言わない（理由の中身になる）
  assert.match(startRefusal('pr_unknown'), /（PR を確かめられず）。.*数秒後にもう一度送れば通ることがあります。相手には何も届いていません/)
  assert.doesNotMatch(startRefusal('unpushed'), /数秒後/)
  assert.doesNotMatch(startRefusal('pr_unknown', true), /数秒後|PR/)
})

test('grownSinceSeen: 一覧で見た値の倍を超え、かつ下限を超えたときだけ。見ていなければ言わない（#795）', () => {
  assert.equal(grownSinceSeen(170_000, 660_000), true)
  assert.equal(grownSinceSeen(170_000, 340_000), false, 'ちょうど倍は超えていない')
  assert.equal(grownSinceSeen(100_000, 250_000), false, '倍は超えたが、下限に届かない')
  assert.equal(grownSinceSeen(400_000, 700_000), false, '下限は超えたが、倍に届かない')
  assert.equal(grownSinceSeen(0, 900_000), false, '一覧を見ていない（立て直しで忘れた）')
  assert.deepEqual([SEEN_CONTEXT_FACTOR, SEEN_CONTEXT_MIN_TOKENS], [2, 300_000])
})
