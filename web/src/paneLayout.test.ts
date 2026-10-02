import { test } from 'node:test'
import assert from 'node:assert/strict'
import { closeColumn, diffModalBelow, EMPTY_LAYOUT, focusColumn, focusedItem, MAX_COLUMNS, normalizeLayout, openBeside, placeItem, sessionIdsIn, type PaneItem, type PaneLayout } from './paneLayout.ts'

const s = (id: string): PaneItem => ({ kind: 'session', id })
/** 番号は見ずに並びとフォーカスだけを比べる形（番号は下の「列の番号」のテストで見る） */
const of = (ids: string[], focus = 0) => ({ columns: ids.map((id) => [s(id)]), focus })
const full = (ids: string[], focus = 0, keys = ids.map((_, i) => i)): PaneLayout => ({ ...of(ids, focus), keys })
const shape = (layout: PaneLayout) => ({ columns: layout.columns, focus: layout.focus })
/** どのセッションがどの番号の列に出ているか */
const slots = (layout: PaneLayout) => Object.fromEntries(layout.columns.map((c, i) => [(c[0] as { id: string }).id, layout.keys[i]]))

test('normalizeLayout: 壊れた値は空の並びにする', () => {
  for (const raw of [null, undefined, 'x', 3, {}, { columns: 'x' }, { columns: [null, 'a', [], [{}], [{ kind: 'feed' }], [{ kind: 'session' }], [{ kind: 'session', id: '' }]] }]) {
    assert.deepEqual(normalizeLayout(raw), EMPTY_LAYOUT)
  }
})

test('normalizeLayout: 1 つ・2 つ・要対応を読む', () => {
  assert.deepEqual(shape(normalizeLayout({ columns: [[s('a')]], focus: 0 })), of(['a']))
  assert.deepEqual(shape(normalizeLayout({ columns: [[s('a')], [s('b')]], focus: 1 })), of(['a', 'b'], 1))
  assert.deepEqual(shape(normalizeLayout({ columns: [[{ kind: 'todo' }], [s('b')]], focus: 0 })), { columns: [[{ kind: 'todo' }], [s('b')]], focus: 0 })
})

test('normalizeLayout: 同じ ID の 2 回目と、上限を超えた列は落とす', () => {
  assert.deepEqual(shape(normalizeLayout({ columns: [[s('a')], [s('a')], [s('b')]], focus: 0 })), of(['a', 'b']))
  const many = normalizeLayout({ columns: ['a', 'b', 'c', 'd', 'e'].map((id) => [s(id)]), focus: 0 })
  assert.equal(many.columns.length, MAX_COLUMNS)
  assert.deepEqual(sessionIdsIn(many), ['a', 'b', 'c'])
})

test('normalizeLayout: 範囲の外・数でない focus は列の中に収める', () => {
  assert.equal(normalizeLayout({ columns: [[s('a')], [s('b')]], focus: 9 }).focus, 1)
  assert.equal(normalizeLayout({ columns: [[s('a')], [s('b')]], focus: -1 }).focus, 0)
  assert.equal(normalizeLayout({ columns: [[s('a')], [s('b')]], focus: 'x' }).focus, 0)
  assert.equal(normalizeLayout({ columns: [[s('a')], [s('b')]], focus: 0.5 }).focus, 0)
})

test('normalizeLayout: 各列は先頭の 1 つだけ（上下はまだ無い）', () => {
  assert.deepEqual(shape(normalizeLayout({ columns: [[s('a'), s('b')]], focus: 0 })), of(['a']))
})

test('placeItem: 空の並びには 1 つ目として入る', () => {
  assert.deepEqual(shape(placeItem(EMPTY_LAYOUT, s('a'))), of(['a']))
})

test('placeItem: 並びに無ければ、フォーカスのあるペインの中身を入れ替える', () => {
  assert.deepEqual(shape(placeItem(full(['a', 'b'], 1), s('c'))), of(['a', 'c'], 1))
  assert.deepEqual(shape(placeItem(full(['a']), s('c'))), of(['c']))
})

test('placeItem: もう並びにあれば、そのペインにフォーカスを移す（2 つ並べない）', () => {
  assert.deepEqual(shape(placeItem(full(['a', 'b'], 0), s('b'))), of(['a', 'b'], 1))
})

test('placeItem: 変わらなければ同じオブジェクトを返す（描画中に比べるので）', () => {
  const layout = full(['a', 'b'], 1)
  assert.equal(placeItem(layout, s('b')), layout)
})

test('openBeside: フォーカスのあるペインの右に足し、フォーカスを移す', () => {
  assert.deepEqual(shape(openBeside(full(['a']), s('b'))), of(['a', 'b'], 1))
  assert.deepEqual(shape(openBeside(full(['a', 'c'], 0), s('b'))), of(['a', 'b', 'c'], 1))
  assert.deepEqual(shape(openBeside(EMPTY_LAYOUT, s('a'))), of(['a']))
})

test('openBeside: もう並びにあれば足さず、フォーカスを移すだけ', () => {
  assert.deepEqual(shape(openBeside(full(['a', 'b'], 0), s('b'))), of(['a', 'b'], 1))
  const layout = full(['a', 'b'], 1)
  assert.equal(openBeside(layout, s('b')), layout)
})

test('openBeside: 上限では右隣（右端なら左隣）の中身を入れ替える。見ていたものは残る', () => {
  assert.deepEqual(shape(openBeside(full(['a', 'b', 'c'], 0), s('x'))), of(['a', 'x', 'c'], 1))
  assert.deepEqual(shape(openBeside(full(['a', 'b', 'c'], 2), s('x'))), of(['a', 'x', 'c'], 1))
})

test('closeColumn: 片方を閉じたら 1 つに戻る。最後の 1 つは閉じない', () => {
  assert.deepEqual(shape(closeColumn(full(['a', 'b'], 1), 1)), of(['a']))
  assert.deepEqual(shape(closeColumn(full(['a', 'b'], 1), 0)), of(['b']))
  const one = full(['a'])
  assert.equal(closeColumn(one, 0), one)
  assert.equal(closeColumn(full(['a', 'b']), 5).columns.length, 2)
})

test('closeColumn: フォーカスは同じペインを指し続け、閉じたのがそのペインなら左隣へ', () => {
  assert.deepEqual(focusedItem(closeColumn(full(['a', 'b', 'c'], 2), 0)), s('c'), '左を閉じても c のまま')
  assert.deepEqual(focusedItem(closeColumn(full(['a', 'b', 'c'], 0), 2)), s('a'), '右を閉じても a のまま')
  assert.deepEqual(focusedItem(closeColumn(full(['a', 'b', 'c'], 1), 1)), s('a'), '自分を閉じたら左隣')
  assert.deepEqual(focusedItem(closeColumn(full(['a', 'b', 'c'], 0), 0)), s('b'), '左端を閉じたら新しい左端')
})

test('focusColumn: 範囲の外と同じ列は何もしない', () => {
  const layout = full(['a', 'b'], 0)
  assert.equal(focusColumn(layout, 0), layout)
  assert.equal(focusColumn(layout, 2), layout)
  assert.deepEqual(shape(focusColumn(layout, 1)), of(['a', 'b'], 1))
})

test('sessionIdsIn: 要対応のペインは含めない', () => {
  assert.deepEqual(sessionIdsIn({ columns: [[{ kind: 'todo' }], [s('b')]], focus: 0, keys: [0, 1] }), ['b'])
})

test('diffModalBelow: 差分を足すと 1 ペインが 400px を切る幅', () => {
  // 差分の幅は clamp(360px, 38vw, 760px)。境目の幅で、残りがちょうど 400px × ペインの数になる
  const paneAt = (width: number, panes: number, sidebar: number) => (width - sidebar - Math.min(Math.max(width * 0.38, 360), 760)) / panes
  assert.equal(diffModalBelow(1, 0), 760, '38vw が 360px を下回る区間（差分は 360px）')
  assert.equal(diffModalBelow(2, 320), 1807, '38vw の区間')
  assert.equal(diffModalBelow(3, 320), 320 + 1200 + 760, '差分が 760px で頭打ちの区間')
  for (const [panes, sidebar] of [[1, 0], [2, 0], [2, 320], [3, 0], [3, 320]] as const) {
    const at = diffModalBelow(panes, sidebar)
    assert.ok(paneAt(at + 1, panes, sidebar) >= 400, `${panes} 枚・サイドバー ${sidebar}: 境目より広ければ 400px 以上`)
    assert.ok(paneAt(at - 2, panes, sidebar) < 400, `${panes} 枚・サイドバー ${sidebar}: 境目より狭ければ 400px を切る`)
  }
})

// ---- 列の番号（React の key）。中身や位置が変わっても、残った列は同じ SessionView のまま

test('列の番号: 中身を入れ替えても、その列の番号は変わらない（1 つのときは同じ SessionView が id だけ変わる）', () => {
  assert.deepEqual(placeItem(full(['a']), s('b')).keys, [0])
  assert.deepEqual(placeItem(full(['a', 'b'], 1, [4, 7]), s('c')).keys, [4, 7])
})

test('列の番号: 間に足しても、右に押し出された列の番号は変わらない', () => {
  const next = openBeside(full(['a', 'c'], 0), s('b'))
  assert.deepEqual(slots(next), { a: 0, b: 2, c: 1 }, 'c は 2 列目から 3 列目へ動いたが番号は 1 のまま')
})

test('列の番号: 左を閉じても、残った列の番号は変わらない', () => {
  assert.deepEqual(slots(closeColumn(full(['a', 'b', 'c'], 2), 0)), { b: 1, c: 2 })
})

test('列の番号: 閉じたあとに足す列は、残っている番号と重ならない', () => {
  const next = openBeside(closeColumn(full(['a', 'b', 'c'], 2), 2), s('x'))
  assert.equal(new Set(next.keys).size, next.keys.length)
})

test('列の番号: 上限での入れ替えは、入れ替えた列の番号を使い回す', () => {
  assert.deepEqual(openBeside(full(['a', 'b', 'c'], 0), s('x')).keys, [0, 1, 2])
})

test('normalizeLayout: 番号が無い・壊れている・重なっているときは、重ならない番号を振る', () => {
  const cols = [[s('a')], [s('b')], [s('c')]]
  assert.deepEqual(normalizeLayout({ columns: cols, focus: 0 }).keys, [0, 1, 2], '番号の無い古い保存')
  assert.deepEqual(normalizeLayout({ columns: cols, focus: 0, keys: [5, 2, 9] }).keys, [5, 2, 9], '読めればそのまま')
  for (const keys of [[1, 1, 1], ['x', null, -1], [0.5, 3], 'x']) {
    const out = normalizeLayout({ columns: cols, focus: 0, keys }).keys
    assert.equal(out.length, 3)
    assert.equal(new Set(out).size, 3, JSON.stringify(keys))
  }
  // 落とした列（同じ ID の 2 回目）の番号は、後ろの列にずらさない
  assert.deepEqual(normalizeLayout({ columns: [[s('a')], [s('a')], [s('b')]], focus: 0, keys: [3, 4, 5] }).keys, [3, 5])
})
