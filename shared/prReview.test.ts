import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseUnifiedDiff } from './diff.ts'
import { githubErrorText, githubReview, moveToBody, parseReviewRequest, reviewEmptyReason, reviewEvents, reviewLineState } from './prReview.ts'
import type { PrReviewLineComment } from './types.ts'

const SHA = 'f'.repeat(40)
const PATCH = [
  'diff --git a/a.ts b/a.ts',
  '--- a/a.ts',
  '+++ b/a.ts',
  '@@ -1,2 +1,3 @@',
  ' keep',
  '-old',
  '+new',
  '+more',
  'diff --git a/gone.ts b/gone.ts',
  'deleted file mode 100644',
  '--- a/gone.ts',
  '+++ /dev/null',
  '@@ -1 +0,0 @@',
  '-bye',
  '',
].join('\n')
const files = parseUnifiedDiff(PATCH)
const c = (extra: Partial<PrReviewLineComment>): PrReviewLineComment => ({ path: 'a.ts', side: 'new', line: 2, code: 'new', body: 'x', ...extra })

test('reviewEvents: 既定は Comment。自分の PR は Comment だけ', () => {
  assert.deepEqual(reviewEvents(false), ['COMMENT', 'APPROVE', 'REQUEST_CHANGES'])
  assert.deepEqual(reviewEvents(true), ['COMMENT'])
})

test('reviewLineState: 同じ中身なら ok、中身が違えば moved、行が無ければ missing。消したファイルは旧いパスで引く', () => {
  assert.equal(reviewLineState(files, c({})), 'ok')
  assert.equal(reviewLineState(files, c({ code: 'NEW' })), 'moved')
  assert.equal(reviewLineState(files, c({ line: 9 })), 'missing')
  assert.equal(reviewLineState(files, c({ path: 'b.ts' })), 'missing')
  assert.equal(reviewLineState(files, c({ side: 'old', line: 2, code: 'old' })), 'ok')
  assert.equal(reviewLineState(files, c({ side: 'new', line: 1, code: 'keep' })), 'ok')
  assert.equal(reviewLineState(files, c({ path: 'gone.ts', side: 'old', line: 1, code: 'bye' })), 'ok')
})

test('githubReview: 位置は差分から引き直し、消した行は LEFT・ほかは RIGHT。空の全体コメントは載せない', () => {
  const r = githubReview(
    { event: 'COMMENT', body: '  ', commit_id: SHA, comments: [c({ body: ' ここ ' }), c({ side: 'old', line: 2, code: 'old', body: 'なぜ' }), c({ line: 1, code: 'keep', body: '文脈' })] },
    files,
  )
  assert.deepEqual(r, {
    ok: true,
    review: {
      commit_id: SHA,
      event: 'COMMENT',
      comments: [
        { path: 'a.ts', line: 2, side: 'RIGHT', body: 'ここ' },
        { path: 'a.ts', line: 2, side: 'LEFT', body: 'なぜ' },
        { path: 'a.ts', line: 1, side: 'RIGHT', body: '文脈' },
      ],
    },
  })
})

test('githubReview: 合わない行が 1 つでもあれば組み立てずに番号を返す', () => {
  const r = githubReview({ event: 'APPROVE', body: 'LGTM', commit_id: SHA, comments: [c({}), c({ code: 'changed' }), c({ line: 9 })] }, files)
  assert.deepEqual(r, { ok: false, stale: [1, 2] })
})

test('parseReviewRequest: 形と空の組み合わせを確かめる', () => {
  const ok = { event: 'COMMENT', body: '', commit_id: SHA, comments: [c({})] }
  assert.equal(parseReviewRequest(ok).ok, true)
  for (const bad of [
    null,
    [],
    { ...ok, event: 'MERGE' },
    { ...ok, commit_id: 'HEAD' },
    { ...ok, body: 1 },
    { ...ok, comments: 'x' },
    { ...ok, comments: [c({ line: 0 })] },
    { ...ok, comments: [c({ line: 1.5 })] },
    { ...ok, comments: [c({ side: 'mid' as never })] },
    { ...ok, comments: [c({ body: '  ' })] },
    { ...ok, comments: [] },
    { ...ok, event: 'REQUEST_CHANGES' },
    { ...ok, body: 'x'.repeat(65_537) },
    { ...ok, comments: Array.from({ length: 101 }, () => c({})) },
  ]) {
    assert.equal(parseReviewRequest(bad).ok, false, JSON.stringify(bad)?.slice(0, 80))
  }
  // Approve は本文も行コメントも無くてよい
  assert.equal(parseReviewRequest({ ...ok, event: 'APPROVE', comments: [] }).ok, true)
})

test('reviewEmptyReason', () => {
  assert.equal(reviewEmptyReason('COMMENT', '', 1), '')
  assert.notEqual(reviewEmptyReason('COMMENT', ' ', 0), '')
  assert.notEqual(reviewEmptyReason('REQUEST_CHANGES', '', 3), '')
  assert.equal(reviewEmptyReason('APPROVE', '', 0), '')
})

test('moveToBody: 場所と書いたときの行を引用して末尾に足す', () => {
  assert.equal(moveToBody('', c({ body: 'ここ' })), '`a.ts:2`\n> new\n\nここ')
  assert.equal(moveToBody('全体\n', c({ code: '', body: 'ここ' })), '全体\n\n`a.ts:2`\n>\n\nここ')
})

test('githubErrorText: GitHub の応答を読み、無ければ stderr の最後の行', () => {
  assert.equal(githubErrorText('{"message":"Validation Failed","errors":[{"message":"line must be part of the diff"}]}', ''), 'Validation Failed: line must be part of the diff')
  assert.equal(githubErrorText('', 'x\ngh: Not Found (HTTP 404)\n'), 'gh: Not Found (HTTP 404)')
  assert.equal(githubErrorText('', ''), 'gh api が失敗しました')
})
