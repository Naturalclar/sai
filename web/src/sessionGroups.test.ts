import { test } from 'node:test'
import assert from 'node:assert/strict'
import { OTHER_LABEL, isCollapsed, sessionGroups, toggleCollapsed, visibleIds } from './sessionGroups.ts'
import type { SessionSummary } from '../../shared/types.ts'

/** 一覧は新しい順で届く（aggregate.ts が end の降順）。ここでは並びだけが意味を持つ */
const s = (id: string, project: string): SessionSummary => ({ id, project } as SessionSummary)

test('sessionGroups: リポジトリごとにまとめ、塊の順は「中で一番新しいセッション」の順（#364）', () => {
  const groups = sessionGroups([s('a@1', 'Naturalclar/sai'), s('b@1', 'acme/kanban'), s('c@1', 'Naturalclar/sai'), s('d@1', 'acme/kanban')])
  assert.deepEqual(groups.map((g) => g.key), ['Naturalclar/sai', 'acme/kanban'], '先に出てきた方が上（= その塊の一番新しいセッションが新しい）')
  assert.deepEqual(groups.map((g) => g.label), ['sai', 'kanban'], '見出しは最後の区切りだけ')
  assert.deepEqual(groups.map((g) => g.sessions.map((x) => x.id)), [['a@1', 'c@1'], ['b@1', 'd@1']], '塊の中は渡された順のまま')
  assert.deepEqual(sessionGroups([]), [])
})

test('sessionGroups: project が空のセッションは「その他」にまとめる', () => {
  const groups = sessionGroups([s('a@1', ''), s('b@1', 'acme/kanban'), s('c@1', '')])
  assert.deepEqual(groups.map((g) => [g.label, g.sessions.length]), [[OTHER_LABEL, 2], ['kanban', 1]])
})

test('sessionGroups: 塊が 1 つでもそのまま返す（見出しを出すかは画面側）', () => {
  assert.deepEqual(sessionGroups([s('a@1', 'Naturalclar/sai')]).map((g) => g.label), ['sai'])
})

test('sessionGroups: 中の「要対応」を数える（畳んでいても見出しに出すため）', () => {
  const groups = sessionGroups([s('a@1', 'o/r'), s('b@1', 'o/r'), s('c@1', 'o/other')], new Set(['a@1', 'b@1']))
  assert.deepEqual(groups.map((g) => [g.label, g.todo]), [['r', 2], ['other', 0]])
  assert.deepEqual(sessionGroups([s('a@1', 'o/r')]).map((g) => g.todo), [0], '渡さなければ 0')
})

test('visibleIds: 畳んだ塊の中は入らない（↑↓ が見えていないセッションに移らない）', () => {
  const groups = sessionGroups([s('a@1', 'o/r'), s('b@1', 'o/other'), s('c@1', 'o/r')])
  assert.deepEqual(visibleIds(groups, []), ['a@1', 'c@1', 'b@1'], '画面の並び（塊ごと）と同じ')
  assert.deepEqual(visibleIds(groups, ['o/r']), ['b@1'])
  assert.deepEqual(visibleIds(groups, ['o/r', 'o/other']), [])
})

test('toggleCollapsed / isCollapsed: 覚えるのは畳んだものだけ', () => {
  assert.equal(isCollapsed([], 'o/r'), false, '既定は開いている')
  const closed = toggleCollapsed([], 'o/r')
  assert.deepEqual(closed, ['o/r'])
  assert.equal(isCollapsed(closed, 'o/r'), true)
  assert.deepEqual(toggleCollapsed(closed, 'o/r'), [], 'もう一度押すと開く')
  assert.deepEqual(toggleCollapsed(closed, 'o/other'), ['o/r', 'o/other'])
  // 「その他」も同じ扱い（key は空文字）
  assert.deepEqual(toggleCollapsed([], ''), [''])
  assert.equal(isCollapsed([''], ''), true)
})
