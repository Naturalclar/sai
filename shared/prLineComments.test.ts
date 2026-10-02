import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseUnifiedDiff } from './diff.ts'
import { PR_LINE_COMMENTS_MAX, hunkLastLine, parsePrLineComments, placeLineThreads, threadLineComments } from './prLineComments.ts'

const raw = (id: number, extra: Record<string, unknown> = {}) => ({
  id,
  in_reply_to_id: null,
  path: 'a.ts',
  line: 2,
  original_line: 2,
  side: 'RIGHT',
  subject_type: 'line',
  user: 'alice',
  user_type: 'User',
  body: `本文 ${id}`,
  created_at: `2026-10-01T00:00:${String(id % 60).padStart(2, '0')}Z`,
  html_url: `https://github.com/o/r/pull/7#discussion_r${id}`,
  diff_hunk: '@@ -1,2 +1,3 @@\n keep\n+added',
  ...extra,
})
const parse = (...items: Record<string, unknown>[]) => parsePrLineComments(items.map((i) => JSON.stringify(i)).join('\n'))

const PATCH = [
  'diff --git a/a.ts b/a.ts',
  '--- a/a.ts',
  '+++ b/a.ts',
  '@@ -1,3 +1,3 @@',
  ' keep',
  '-gone',
  '+added',
  ' tail',
  'diff --git a/old.ts b/new.ts',
  'similarity index 90%',
  'rename from old.ts',
  'rename to new.ts',
  '--- a/old.ts',
  '+++ b/new.ts',
  '@@ -1 +1 @@',
  '-x',
  '+y',
  '',
].join('\n')
const FILES = parseUnifiedDiff(PATCH)

test('hunkLastLine: コメントの付いた行の中身。頭の記号を外す', () => {
  assert.equal(hunkLastLine('@@ -1 +1,2 @@\n-old\n+new'), 'new')
  assert.equal(hunkLastLine('@@ -1 +1,2 @@\n ctx\r\n'), 'ctx')
  assert.equal(hunkLastLine('@@ -1 +1 @@\n-a\n+b\n\\ No newline at end of file'), 'b')
  assert.equal(hunkLastLine('@@ -1 +1 @@\n+'), '', '空の行')
  assert.equal(hunkLastLine(''), null)
  assert.equal(hunkLastLine('@@ -1 +1 @@'), null, '行が無い')
})

test('parsePrLineComments: 1 行 1 件を読む。側・いまの行・付いた行の中身・返信の指す先', () => {
  const out = parse(
    raw(2, { in_reply_to_id: 1, user: 'bob' }),
    raw(1),
    raw(3, { side: 'LEFT', line: null, original_line: 9, diff_hunk: '@@ -9 +9 @@\n-was' }),
    raw(4, { subject_type: 'file', line: null, original_line: null, diff_hunk: '' }),
    raw(5, { user: 'ci[bot]', html_url: 'javascript:alert(1)' }),
    raw(6, { user: 'app', user_type: 'Bot' }),
  )
  assert.deepEqual(out?.comments.map((c) => c.id), [1, 2, 3, 4, 5, 6], '時刻の古い順')
  const [c1, c2, c3, c4, c5, c6] = out?.comments ?? []
  assert.deepEqual(c1, { id: 1, path: 'a.ts', side: 'new', line: 2, original_line: 2, code: 'added', author: 'alice', at: '2026-10-01T00:00:01Z', body: '本文 1', url: 'https://github.com/o/r/pull/7#discussion_r1' })
  assert.equal(c2?.reply_to, 1)
  assert.deepEqual([c3?.side, c3?.line, c3?.original_line, c3?.code], ['old', 0, 9, 'was'], '前の版へのコメントは line が 0')
  assert.deepEqual([c4?.file_level, c4?.line, c4?.code], [true, 0, undefined])
  assert.deepEqual([c5?.bot, c5?.url], [true, ''])
  assert.equal(c6?.bot, true)
  assert.equal(out?.omitted, 0)
})

test('parsePrLineComments: 空は 0 件。読めない行が 1 つでもあれば null。上限を超えたら古い方を落とす', () => {
  assert.deepEqual(parsePrLineComments(''), { comments: [], omitted: 0 })
  assert.equal(parsePrLineComments(`${JSON.stringify(raw(1))}\n{"id": 2, "pa`), null)
  assert.equal(parsePrLineComments('[]'), null, '配列のまま（--jq が効いていない）')
  const many = Array.from({ length: PR_LINE_COMMENTS_MAX + 2 }, (_, i) => raw(i + 1, { created_at: new Date(Date.UTC(2026, 9, 1, 0, 0, i)).toISOString() }))
  const out = parse(...many)
  assert.equal(out?.comments.length, PR_LINE_COMMENTS_MAX)
  assert.equal(out?.omitted, 2)
  assert.equal(out?.comments[0]?.id, 3)
})

test('threadLineComments: 返信を最初のコメントの下にまとめる。指す先の無い返信は自分が先頭になる', () => {
  const list = parse(raw(1), raw(2, { in_reply_to_id: 1 }), raw(3), raw(4, { in_reply_to_id: 1 }), raw(5, { in_reply_to_id: 99 }))?.comments ?? []
  const threads = threadLineComments(list)
  assert.deepEqual(threads.map((t) => [t.root.id, t.replies.map((r) => r.id)]), [[1, [2, 4]], [3, []], [5, []]])
})

test('placeLineThreads: いまの差分のその側のその行で、中身が同じときだけ行に当てる', () => {
  const list = parse(
    raw(1, { line: 2, diff_hunk: '@@ -1,3 +1,3 @@\n keep\n-gone\n+added' }), // 足した行
    raw(2, { side: 'LEFT', line: 2, diff_hunk: '@@ -1,3 +1,3 @@\n keep\n-gone' }), // 消した行
    raw(3, { side: 'LEFT', line: 1, diff_hunk: '@@ -1,3 +1,3 @@\n keep' }), // 左側の文脈の行
    raw(4, { line: 2, diff_hunk: '@@ -1,3 +1,3 @@\n keep\n+別の中身' }), // 行はあるが中身が違う
    raw(5, { line: null, original_line: 7 }), // 前の版へのコメント
    raw(6, { subject_type: 'file', line: null }), // ファイル全体
    raw(7, { path: 'none.ts' }), // 差分に無いファイル
    raw(8, { line: 40 }), // 差分に無い行
    raw(9, { path: 'old.ts', line: 1, diff_hunk: '@@ -1 +1 @@\n-x\n+y' }), // リネーム前のパスで付いた
    raw(10, { line: 3, diff_hunk: '' }), // 中身が取れない → 行番号だけで当てる
  )?.comments ?? []
  const { placed, rest } = placeLineThreads(threadLineComments(list), FILES)
  assert.deepEqual(placed.map((p) => [p.thread.root.id, p.path, p.side, p.line]), [
    [1, 'a.ts', 'new', 2],
    [2, 'a.ts', 'old', 2],
    [3, 'a.ts', 'new', 1], // 画面の行の鍵は新しい側（文脈の行）
    [9, 'new.ts', 'new', 1],
    [10, 'a.ts', 'new', 3],
  ])
  assert.deepEqual(rest.map((t) => t.root.id), [4, 5, 6, 7, 8])
})

test('placeLineThreads: 同じ名前のファイルを先に探す（移したファイルの旧いパスと、新しく足した同名のファイル）', () => {
  const patch = [
    'diff --git a/b.ts b/a.ts',
    'similarity index 90%',
    'rename from b.ts',
    'rename to a.ts',
    '--- a/b.ts',
    '+++ b/a.ts',
    '@@ -1 +1 @@',
    '-x',
    '+same',
    'diff --git a/b.ts b/b.ts',
    'new file mode 100644',
    '--- /dev/null',
    '+++ b/b.ts',
    '@@ -0,0 +1 @@',
    '+same',
    '',
  ].join('\n')
  const list = parse(raw(1, { path: 'b.ts', line: 1, diff_hunk: '@@ -0,0 +1 @@\n+same' }))?.comments ?? []
  const { placed } = placeLineThreads(threadLineComments(list), parseUnifiedDiff(patch))
  assert.deepEqual(placed.map((p) => p.path), ['b.ts'], '新しい b.ts に出す（b.ts から移した a.ts ではない）')
})

test('placeLineThreads: CRLF のファイルでも行に当たる（差分の行に残る \\r を外して比べる）', () => {
  const patch = ['diff --git a/w.ts b/w.ts', '--- a/w.ts', '+++ b/w.ts', '@@ -1 +1,2 @@', ' keep\r', '+added\r', ''].join('\n')
  const list = parse(raw(1, { path: 'w.ts', line: 2, diff_hunk: '@@ -1 +1,2 @@\n keep\r\n+added\r' }))?.comments ?? []
  const { placed, rest } = placeLineThreads(threadLineComments(list), parseUnifiedDiff(patch))
  assert.deepEqual([placed.length, rest.length], [1, 0])
})

test('hunkLastLine: jq で最後の 2 行に切った形でも同じ行が取れる', () => {
  assert.equal(hunkLastLine(' keep\n+added'), 'added')
  assert.equal(hunkLastLine('+b\n\\ No newline at end of file'), 'b')
  assert.equal(hunkLastLine('@@ -1 +1 @@\n+only'), 'only')
})
