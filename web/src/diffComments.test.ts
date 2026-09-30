import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseUnifiedDiff } from '../../shared/diff.ts'
import { DIFF_COMMENTS_MAX, commentMoved, formatDiffComments, lineAnchor, parseDiffComments, sameLine, withDiffComments } from './diffComments.ts'
import type { DiffComment } from './diffComments.ts'

const comment = (over: Partial<DiffComment> = {}): DiffComment => ({
  id: 'c1',
  section: 'working',
  path: 'server/app.ts',
  side: 'new',
  line: 2,
  kind: 'add',
  code: 'const b = 2',
  body: 'ここは定数にしたい',
  ...over,
})

const PATCH = [
  'diff --git a/server/app.ts b/server/app.ts',
  '--- a/server/app.ts',
  '+++ b/server/app.ts',
  '@@ -1,2 +1,2 @@',
  ' const a = 1',
  '-const b = 1',
  '+const b = 2',
  '',
].join('\n')

test('lineAnchor: 消した行は旧い側、足した行と文脈の行は新しい側の行番号', () => {
  const [file] = parseUnifiedDiff(PATCH)
  const [ctx, del, add] = file!.hunks[0]!.lines
  assert.deepEqual(lineAnchor(ctx!), { side: 'new', line: 1 })
  assert.deepEqual(lineAnchor(del!), { side: 'old', line: 2 })
  assert.deepEqual(lineAnchor(add!), { side: 'new', line: 2 })
})

test('sameLine: 区切り・パス・側・行番号がそろったときだけ同じ行', () => {
  assert.equal(sameLine(comment(), comment({ body: '別の' })), true)
  assert.equal(sameLine(comment(), comment({ section: 'branch' })), false)
  assert.equal(sameLine(comment(), comment({ side: 'old' })), false, '同じ行番号でも消した行とは別')
})

test('parseDiffComments: 壊れていたら空、形の合わない・本文の空の項目は捨てる', () => {
  assert.deepEqual(parseDiffComments(null), {})
  assert.deepEqual(parseDiffComments('{壊れた'), {})
  assert.deepEqual(parseDiffComments('[1]'), {})
  const raw = JSON.stringify({ 'S@r': [comment(), { id: 'x' }, comment({ id: 'c2', body: '  ' })], 'T@r': 'ちがう' })
  assert.deepEqual(parseDiffComments(raw), { 'S@r': [comment()] })
})

test('withDiffComments: 置き換える。空にしたら消し、上限で切る', () => {
  const all = { 'S@r': [comment()] }
  assert.deepEqual(withDiffComments(all, 'S@r', []), {})
  assert.deepEqual(all, { 'S@r': [comment()] }, '元は変えない')
  const many = Array.from({ length: DIFF_COMMENTS_MAX + 5 }, (_, i) => comment({ id: `c${i}` }))
  assert.equal(withDiffComments({}, 'S@r', many)['S@r']!.length, DIFF_COMMENTS_MAX)
})

test('commentMoved: いまの差分で同じ場所の中身が違えば「変わった」。まだ読めていなければ言わない', () => {
  const files = parseUnifiedDiff(PATCH)
  assert.equal(commentMoved(comment(), files), false)
  assert.equal(commentMoved(comment({ code: 'const b = 3' }), files), true, 'エージェントが書き換えた')
  assert.equal(commentMoved(comment({ line: 40 }), files), true, '行が差分から消えた')
  assert.equal(commentMoved(comment({ path: 'gone.ts' }), files), true)
  assert.equal(commentMoved(comment({ code: 'x' }), null), false)
})

test('formatDiffComments: 区切り → パス → 行の順に、行の中身を引用してコメントを並べる', () => {
  const text = formatDiffComments([
    comment({ id: 'b', path: 'web/src/b.ts', line: 9, body: 'B' }),
    comment({ id: 'a', line: 2, body: 'A\n' }),
    comment({ id: 'd', side: 'old', kind: 'del', line: 2, code: 'const b = 1', body: '消さないで' }),
  ])
  assert.equal(
    text,
    [
      '差分へのコメントです（未コミット）。',
      'server/app.ts:2（追加した行）\n> const b = 2\nA',
      'server/app.ts:2（消した行）\n> const b = 1\n消さないで',
      'web/src/b.ts:9（追加した行）\n> const b = 2\nB',
    ].join('\n\n'),
  )
  assert.equal(formatDiffComments([]), '')
})

test('formatDiffComments: 区切りが混ざったら、どちらの差分かを行ごとに書く', () => {
  const text = formatDiffComments([comment({ id: 'w' }), comment({ id: 'b', section: 'branch', path: 'z.ts', code: '' })])
  assert.match(text, /^差分へのコメントです（ブランチの差分 \/ 未コミット）。/)
  assert.match(text, /z\.ts:2（ブランチの差分・追加した行）\n>\n/, '空の行は引用だけ')
  assert.ok(text.indexOf('z.ts') < text.indexOf('server/app.ts'), 'ブランチの差分が先')
})

test('formatDiffComments: heading を渡すと 1 行目をそれにする（PR の差分へのコメント。#525）', () => {
  const text = formatDiffComments([comment({ id: 'p', section: 'branch' })], 'PR #525「x」の差分へのコメントです（https://github.com/o/r/pull/525）。')
  assert.match(text, /^PR #525「x」の差分へのコメントです（https:\/\/github\.com\/o\/r\/pull\/525）。\n\n/)
  assert.doesNotMatch(text, /^差分へのコメントです/)
})
