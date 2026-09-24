import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseRecent, recentRows } from './recentRows.ts'

const NOW = Date.parse('2026-09-25T12:00:00+09:00')
const rows = [
  { ts: '2026-09-04T10:00:00+09:00', id: 'old' },
  { ts: '2026-09-18T11:59:59+09:00', id: 'edge-out' },
  { ts: '2026-09-18T12:00:00+09:00', id: 'edge-in' },
  { ts: '2026-09-24T10:00:00+09:00', id: 'new' },
]

test('recentRows: 直近 N 日だけ残し、落とした数を返す', () => {
  const got = recentRows(rows, 7, NOW)
  assert.deepEqual(got.rows.map((r) => r.id), ['edge-in', 'new'])
  assert.equal(got.older, 2)
})

test('recentRows: 日数を増やすとその分さかのぼる', () => {
  assert.deepEqual(recentRows(rows, 30, NOW), { rows, older: 0 })
})

test('recentRows: 検索の飛び先はそこまで含める（落とすと飛べない）', () => {
  const got = recentRows(rows, 7, NOW, '2026-09-04T10:00:00+09:00')
  assert.equal(got.older, 0)
  assert.equal(got.rows.length, 4)
  assert.equal(recentRows(rows, 7, NOW, 'でたらめ').older, 2, '読めない飛び先は無視する')
})

test('recentRows: 時刻の読めない行は落とさない', () => {
  const got = recentRows([{ ts: '' }, {}], 7, NOW)
  assert.equal(got.rows.length, 2)
  assert.equal(got.older, 0)
})

test('parseRecent: 無い・読めない・0 以下は絞らない', () => {
  assert.equal(parseRecent(null), null)
  assert.equal(parseRecent('x'), null)
  assert.equal(parseRecent('0'), null)
  assert.equal(parseRecent('14'), 14)
})
