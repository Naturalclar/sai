import { test } from 'node:test'
import assert from 'node:assert/strict'
import { olderPrompts, parseRecent, recentRows } from './recentRows.ts'

const rows = [
  { ts: '2026-09-04T10:00:00+09:00', id: 'old' },
  { ts: '2026-09-17T09:59:59+09:00', id: 'edge-out' },
  { ts: '2026-09-17T10:00:00+09:00', id: 'edge-in' },
  { ts: '2026-09-24T10:00:00+09:00', id: 'new' },
]

test('recentRows: 一番新しい行から N 日だけ残し、落とした数を返す', () => {
  const got = recentRows(rows, 7)
  assert.deepEqual(got.rows.map((r) => r.id), ['edge-in', 'new'])
  assert.equal(got.older, 2)
  assert.deepEqual(got.dropped.map((r) => r.id), ['old', 'edge-out'])
})

test('recentRows: しばらく触っていないセッションでも空にしない（起点はいまではなく最後の行）', () => {
  const stale = [{ ts: '2026-06-01T10:00:00+09:00' }, { ts: '2026-06-02T10:00:00+09:00' }]
  assert.equal(recentRows(stale, 7).rows.length, 2)
})

test('recentRows: 日数を増やすとその分さかのぼる', () => {
  assert.deepEqual(recentRows(rows, 30), { rows, older: 0, dropped: [] })
})

test('recentRows: 検索の飛び先はそこまで含める（落とすと飛べない）', () => {
  const got = recentRows(rows, 7, '2026-09-04T10:00:00+09:00')
  assert.equal(got.older, 0)
  assert.equal(got.rows.length, 4)
  assert.equal(recentRows(rows, 7, 'でたらめ').older, 2, '読めない飛び先は無視する')
})

test('recentRows: 時刻の読めない行は落とさない', () => {
  const got = recentRows([{ ts: '' }, {}, { ts: '2026-09-24T10:00:00+09:00' }], 7)
  assert.equal(got.rows.length, 3)
  assert.equal(got.older, 0)
})

test('olderPrompts: 落とした行の入力を新しい順に、連続する同じ文を畳んで上限まで', () => {
  const dropped = [{ user_text: 'a' }, { user_text: 'b' }, { user_text: 'b' }, {}, { user_text: ' c ' }]
  assert.deepEqual(olderPrompts(dropped), ['c', 'b', 'a'])
  assert.deepEqual(olderPrompts(dropped, 2), ['c', 'b'])
})

test('parseRecent: 無い・読めない・0 以下は絞らない', () => {
  assert.equal(parseRecent(null), null)
  assert.equal(parseRecent('x'), null)
  assert.equal(parseRecent('0'), null)
  assert.equal(parseRecent('14'), 14)
})
