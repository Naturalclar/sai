import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { PrComment, PrLineComment } from '../../shared/types.ts'
import { quotePrComment, quotePrLineThread } from './prCommentQuote.ts'

const PR = { number: 7, title: '直す', url: 'https://github.com/o/r/pull/7' }
const comment = (extra: Partial<PrComment> = {}): PrComment => ({ id: 'c1', kind: 'comment', author: 'alice', at: '2026-10-01T00:00:00Z', body: '1 行目\n\n3 行目', url: '', ...extra })
const line = (id: number, extra: Partial<PrLineComment> = {}): PrLineComment => ({ id, path: 'a.ts', side: 'new', line: 12, original_line: 12, code: 'const x = 1', author: 'alice', at: '2026-10-01T00:00:00Z', body: 'ここは逆では', url: '', ...extra })

test('quotePrComment: どの PR の話かを先に書き、本文は引用にする。レビューは判定を添える', () => {
  assert.equal(quotePrComment(PR, comment()), 'PR #7「直す」に付いたコメントです（https://github.com/o/r/pull/7）。\n\nalice:\n> 1 行目\n>\n> 3 行目')
  assert.equal(
    quotePrComment(PR, comment({ kind: 'review', state: 'CHANGES_REQUESTED', author: 'bob', body: 'テストが要ります\r\n' })),
    'PR #7「直す」に付いたレビューです（https://github.com/o/r/pull/7）。\n\nbob（修正の依頼）:\n> テストが要ります',
  )
  assert.equal(quotePrComment(PR, comment({ kind: 'review', state: 'APPROVED', author: '', body: '' })), 'PR #7「直す」に付いたレビューです（https://github.com/o/r/pull/7）。\n\nghost（承認）:')
})

test('quotePrLineThread: ファイル・行・その行の中身のあとに、最初のコメントと返信を書いた人つきで並べる', () => {
  const text = quotePrLineThread(PR, { root: line(1), replies: [line(2, { author: 'bob', body: '直します' })] })
  assert.equal(text, 'PR #7「直す」に付いた行コメントです（https://github.com/o/r/pull/7）。\n\na.ts:12\n> const x = 1\n\nalice:\n> ここは逆では\n\nbob:\n> 直します')
})

test('quotePrLineThread: 前の版へのコメントは元の行番号とその旨、ファイル全体はパスだけ', () => {
  const outdated = quotePrLineThread(PR, { root: line(1, { line: 0, original_line: 40 }), replies: [] })
  assert.match(outdated, /\na\.ts:40（前の版へのコメント。いまの差分ではこの行が変わっています）\n> const x = 1\n/)
  const { code: _code, ...noCode } = line(1, { line: 0, original_line: 0, file_level: true })
  const file = quotePrLineThread(PR, { root: noCode, replies: [] })
  assert.match(file, /\n\na\.ts（ファイル全体へのコメント）\n\nalice:\n/)
  assert.match(quotePrLineThread(PR, { root: line(1, { code: '' }), replies: [] }), /\na\.ts:12\n>\n\nalice/, '空の行')
})

test('上限で切られたコメントは、途中までだと分かる 1 行と全文の場所を添える', () => {
  const c = quotePrComment(PR, comment({ body: '長い本文', truncated: true, url: 'https://github.com/o/r/pull/7#issuecomment-1' }))
  assert.ok(c.endsWith('> 長い本文\n（長いので途中までです。全文: https://github.com/o/r/pull/7#issuecomment-1）'), c)
  assert.ok(quotePrComment(PR, comment({ kind: 'review', truncated: true })).endsWith('（長いので途中までです。全文は GitHub で読んでください）'))
  const t = quotePrLineThread(PR, { root: line(1), replies: [line(2, { author: 'bob', body: '返信', truncated: true, url: 'https://github.com/o/r/pull/7#discussion_r2' })] })
  assert.ok(t.endsWith('bob:\n> 返信\n（長いので途中までです。全文: https://github.com/o/r/pull/7#discussion_r2）'), t)
  assert.ok(!quotePrComment(PR, comment()).includes('途中まで'))
})
