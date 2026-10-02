import { test } from 'node:test'
import assert from 'node:assert/strict'
import { PR_COMMENT_MAX_CHARS, PR_COMMENTS_MAX, parsePrComments } from './prComments.ts'

const comment = (id: string, createdAt: string, extra: Record<string, unknown> = {}) => ({
  id,
  author: { login: 'alice' },
  body: `本文 ${id}`,
  createdAt,
  isMinimized: false,
  url: `https://github.com/o/r/pull/7#issuecomment-${id}`,
  ...extra,
})
const review = (id: string, submittedAt: string, state: string, body = '', extra: Record<string, unknown> = {}) => ({ id, author: { login: 'bob' }, body, submittedAt, state, ...extra })
const parse = (comments: unknown[], reviews: unknown[]) => parsePrComments(JSON.stringify({ comments, reviews }))

test('会話のコメントとレビューを、時刻の古い順の 1 本にする。レビューには判定が付く', () => {
  const out = parse(
    [comment('c1', '2026-10-01T03:00:00Z'), comment('c2', '2026-10-01T01:00:00Z')],
    [review('r1', '2026-10-01T02:00:00Z', 'APPROVED', 'よさそう')],
  )
  assert.deepEqual(out?.comments.map((c) => [c.id, c.kind, c.author, c.state]), [
    ['c2', 'comment', 'alice', undefined],
    ['r1', 'review', 'bob', 'APPROVED'],
    ['c1', 'comment', 'alice', undefined],
  ])
  assert.equal(out?.comments[0]?.url, 'https://github.com/o/r/pull/7#issuecomment-c2')
  assert.equal(out?.comments[1]?.url, '', 'レビューに url は無い')
  assert.equal(out?.omitted, 0)
})

test('本文の無い COMMENTED のレビュー（行コメントの入れ物）と PENDING は出さない。本文の無い承認・修正の依頼は出す', () => {
  const out = parse(
    [],
    [
      review('r1', '2026-10-01T01:00:00Z', 'COMMENTED', '  '),
      review('r2', '2026-10-01T02:00:00Z', 'PENDING', '書きかけ'),
      review('r3', '2026-10-01T03:00:00Z', 'APPROVED'),
      review('r4', '2026-10-01T04:00:00Z', 'CHANGES_REQUESTED'),
      review('r5', '2026-10-01T05:00:00Z', 'COMMENTED', '全体として'),
    ],
  )
  assert.deepEqual(out?.comments.map((c) => c.id), ['r3', 'r4', 'r5'])
})

test('畳まれたものと bot のものは folded が付く（畳まれている方が先）。bot は名前で見る', () => {
  // 実測: gh はコメント・レビューの書いた人を {login} だけで返す（is_bot も [bot] も付かない）
  const out = parse(
    [
      comment('c1', '2026-10-01T01:00:00Z', { isMinimized: true, minimizedReason: 'outdated' }),
      comment('c2', '2026-10-01T02:00:00Z', { author: { login: 'github-actions' } }),
      comment('c3', '2026-10-01T03:00:00Z', { author: { login: 'dependabot[bot]' } }),
      comment('c4', '2026-10-01T04:00:00Z', { author: { login: 'app/some-app' }, isMinimized: true }),
      comment('c5', '2026-10-01T05:00:00Z'),
      comment('c6', '2026-10-01T06:00:00Z', { author: { login: 'Codecov' } }),
      comment('c7', '2026-10-01T07:00:00Z', { author: { login: 'robot-fan' } }),
    ],
    [review('r1', '2026-10-01T08:00:00Z', 'COMMENTED', '自動のレビュー', { author: { login: 'copilot-pull-request-reviewer' } })],
  )
  assert.deepEqual(out?.comments.map((c) => c.folded), ['minimized', 'bot', 'bot', 'minimized', undefined, 'bot', undefined, 'bot'])
})

test('長い本文は上限で切って truncated。絵文字の途中では切らない', () => {
  const long = '😀'.repeat(PR_COMMENT_MAX_CHARS + 5)
  const out = parse([comment('c1', '2026-10-01T01:00:00Z', { body: long }), comment('c2', '2026-10-01T02:00:00Z', { body: '😀'.repeat(PR_COMMENT_MAX_CHARS) })], [])
  assert.equal(Array.from(out?.comments[0]?.body ?? '').length, PR_COMMENT_MAX_CHARS)
  assert.equal(out?.comments[0]?.truncated, true)
  assert.equal(out?.comments[0]?.body.endsWith('😀'), true)
  assert.equal(out?.comments[1]?.truncated, undefined, 'ちょうど上限は切らない（UTF-16 の長さでは超えている）')
})

test('件数の上限を超えたら古い方を落とし、落とした数を返す', () => {
  const many = Array.from({ length: PR_COMMENTS_MAX + 3 }, (_, i) => comment(`c${i}`, new Date(Date.UTC(2026, 9, 1, 0, i)).toISOString()))
  const out = parse(many, [])
  assert.equal(out?.comments.length, PR_COMMENTS_MAX)
  assert.equal(out?.omitted, 3)
  assert.equal(out?.comments[0]?.id, 'c3')
  assert.equal(out?.comments.at(-1)?.id, `c${PR_COMMENTS_MAX + 2}`)
})

test('読めない出力は null（「コメントが無い」の空と分ける）。形の悪い 1 件は飛ばす', () => {
  assert.equal(parsePrComments('not json'), null)
  assert.equal(parsePrComments('[]'), null)
  assert.equal(parsePrComments('{"comments":[]}'), null, 'reviews が無い')
  assert.deepEqual(parse([], []), { comments: [], omitted: 0 })
  const out = parse([null, 'x', { id: 'no-time', body: 'b' }, comment('ok', '2026-10-01T01:00:00Z', { author: null, url: 'javascript:alert(1)' })], [])
  assert.deepEqual(out?.comments, [{ id: 'ok', kind: 'comment', author: '', at: '2026-10-01T01:00:00Z', body: '本文 ok', url: '' }])
})
