import { test } from 'node:test'
import assert from 'node:assert/strict'
import { closeColumn, EMPTY_LAYOUT, focusColumn, focusedItem, MAX_COLUMNS, nextUnshown, normalizeLayout, openBeside, openInNeighbor, placeItem, sessionIdsIn, type PaneItem, type PaneLayout } from './paneLayout.ts'

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

// ---- 要対応の行からセッションへ: 隣のペインに開く

const todo: PaneItem = { kind: 'todo' }
const withTodo = (rest: string[], focus = 0, at = 0): PaneLayout => {
  const columns = rest.map((id) => [s(id)])
  columns.splice(at, 0, [todo])
  return { columns, focus, keys: columns.map((_, i) => i) }
}

test('openInNeighbor: 隣が無ければ右に 1 つ足す。要対応は残り、フォーカスは開いた方へ', () => {
  assert.deepEqual(shape(openInNeighbor(withTodo([]), s('a'))), { columns: [[todo], [s('a')]], focus: 1 })
})

test('openInNeighbor: 右隣があれば中身を入れ替える（行を順に開いてもペインが増えない）', () => {
  const next = openInNeighbor(withTodo(['a']), s('b'))
  assert.deepEqual(shape(next), { columns: [[todo], [s('b')]], focus: 1 })
  assert.deepEqual(next.keys, [0, 1], '同じ列を使い回す')
  assert.deepEqual(shape(openInNeighbor(withTodo(['a', 'b']), s('c'))), { columns: [[todo], [s('c')], [s('b')]], focus: 1 })
})

test('openInNeighbor: 上限で右隣が無ければ左隣を入れ替える', () => {
  assert.deepEqual(shape(openInNeighbor(withTodo(['a', 'b'], 2, 2), s('c'))), { columns: [[s('a')], [s('c')], [todo]], focus: 1 })
})

test('openInNeighbor: もう並びにあれば、そのペインにフォーカスを移すだけ', () => {
  assert.deepEqual(shape(openInNeighbor(withTodo(['a', 'b']), s('b'))), { columns: [[todo], [s('a')], [s('b')]], focus: 2 })
})

test('openInNeighbor: 空の並びには 1 つ目として入る', () => {
  assert.deepEqual(shape(openInNeighbor(EMPTY_LAYOUT, s('a'))), of(['a']))
})

// ---- % で分けたときに入れるセッション

test('nextUnshown: サイドバーの並びで、いまの次の、まだ出していないもの', () => {
  assert.equal(nextUnshown(['a', 'b', 'c', 'd'], ['a'], 'a'), 'b')
  assert.equal(nextUnshown(['a', 'b', 'c', 'd'], ['a', 'b'], 'a'), 'c', '次がもう出ていれば、その次')
})

test('nextUnshown: 末尾まで無ければ先頭に戻って探す', () => {
  assert.equal(nextUnshown(['a', 'b', 'c'], ['c'], 'c'), 'a')
  assert.equal(nextUnshown(['a', 'b', 'c'], ['b', 'c'], 'b'), 'a')
})

test('nextUnshown: いまが要対応・並びに無いセッションなら先頭から', () => {
  assert.equal(nextUnshown(['a', 'b'], [], ''), 'a')
  assert.equal(nextUnshown(['a', 'b'], ['a', 'zz'], 'zz'), 'b')
})

test('nextUnshown: 出していないものが無ければ null（分けない）', () => {
  assert.equal(nextUnshown(['a', 'b'], ['a', 'b'], 'a'), null)
  assert.equal(nextUnshown([], [], ''), null)
})
