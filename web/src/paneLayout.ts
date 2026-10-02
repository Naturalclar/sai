// チャットの領域を左右に分けて、複数のセッションを並べて見る（#633）。並びの形と、その動かし方。
// DOM に依存しないので paneLayout.test.ts を node:test で回す。並びを持つのは App.tsx（localStorage の `sai.panes`）。
//
// **URL（hash）はフォーカスのあるペインの 1 つを指す**（`parseRoute()` は変えない）。並びは URL に載せないので、
// 「戻る」で戻るのは見ているセッションだけで、並びは戻らない。

/** ペインに出すもの。種類つきで持つ（要対応もペインに出せるようにするため。フィードは入れない） */
export type PaneItem = { kind: 'session'; id: string } | { kind: 'todo' }

/**
 * 並び。**列の配列で、各列が上から下への配列**（いまはどの列も 1 つ。上下に分けるのを後で足すための形）。
 * `focus` はフォーカスのある列（左から 0 始まり）
 */
export interface PaneLayout {
  columns: PaneItem[][]
  focus: number
  /**
   * 列ごとの番号（React の key）。**中身を入れ替えても列の番号は変わらず、左を閉じた・間に足したときも
   * 残った列の番号は動かない**（列の位置を key にすると、右のペインが別の `SessionView` に付け替わって
   * 送った直後の分・確認待ち・読んでいた場所を失う。#641 のレビュー）
   */
  keys: number[]
}

/** 左右に並べる上限。数字はここ 1 つ */
export const MAX_COLUMNS = 3

export const EMPTY_LAYOUT: PaneLayout = { columns: [], focus: 0, keys: [] }

export const sameItem = (a: PaneItem, b: PaneItem): boolean => a.kind === b.kind && (a.kind !== 'session' || a.id === (b as { id: string }).id)

/** まだ使っていない列の番号 */
const nextKey = (keys: readonly number[]): number => keys.reduce((max, k) => Math.max(max, k), -1) + 1

function itemOf(raw: unknown): PaneItem | null {
  if (typeof raw !== 'object' || raw === null) return null
  const { kind, id } = raw as { kind?: unknown; id?: unknown }
  if (kind === 'todo') return { kind: 'todo' }
  if (kind === 'session' && typeof id === 'string' && id !== '') return { kind: 'session', id }
  return null
}

/**
 * localStorage から読んだものを並びにする。壊れた値・知らない種類・同じものの 2 回目は落とし、上限を超えた列も落とす。
 * いまは各列の先頭の 1 つだけを取る（上下はまだ無い）
 */
export function normalizeLayout(raw: unknown): PaneLayout {
  const { columns, focus, keys } = (typeof raw === 'object' && raw !== null ? raw : {}) as { columns?: unknown; focus?: unknown; keys?: unknown }
  const out: PaneItem[][] = []
  const outKeys: number[] = []
  const rawKeys = Array.isArray(keys) ? keys : []
  let at = -1
  for (const column of Array.isArray(columns) ? columns : []) {
    at++
    const item = itemOf(Array.isArray(column) ? column[0] : undefined)
    if (!item || out.some((c) => sameItem(c[0]!, item))) continue
    out.push([item])
    // 番号が無い・数でない・重なっているときは、まだ使っていない番号を振る
    const key: unknown = rawKeys[at]
    outKeys.push(typeof key === 'number' && Number.isInteger(key) && key >= 0 && !outKeys.includes(key) ? key : nextKey(outKeys))
    if (out.length === MAX_COLUMNS) break
  }
  const want = typeof focus === 'number' && Number.isInteger(focus) ? focus : 0
  return { columns: out, focus: Math.min(Math.max(want, 0), Math.max(out.length - 1, 0)), keys: outKeys }
}

/** 各列に出ているもの（左から） */
export const paneItems = (layout: PaneLayout): PaneItem[] => layout.columns.map((c) => c[0]!)

export const focusedItem = (layout: PaneLayout): PaneItem | null => layout.columns[layout.focus]?.[0] ?? null

const columnOf = (layout: PaneLayout, item: PaneItem): number => layout.columns.findIndex((c) => sameItem(c[0]!, item))

/**
 * URL が指すものを並びに反映する（ふつうのクリック・`↑↓`・「戻る」）。**変わらなければ同じオブジェクトを返す。**
 * - もう並びにあれば、そのペインにフォーカスを移す（同じものを 2 つ並べない）
 * - 無ければ、フォーカスのあるペインの中身を入れ替える
 */
export function placeItem(layout: PaneLayout, item: PaneItem): PaneLayout {
  const at = columnOf(layout, item)
  if (at >= 0) return at === layout.focus ? layout : { ...layout, focus: at }
  if (layout.columns.length === 0) return { columns: [[item]], focus: 0, keys: [0] }
  return { ...layout, columns: layout.columns.map((c, i) => (i === layout.focus ? [item] : c)) }
}

/**
 * 横に並べて開く（⌘ + クリック・項目のボタン）。フォーカスは開いた方へ移る。
 * - もう並びにあれば、そのペインにフォーカスを移すだけ
 * - フォーカスのあるペインの右に足す
 * - 上限に達していれば、右隣のペインの中身を入れ替える（右端にいれば左隣）。いま見ているものは残る
 */
export function openBeside(layout: PaneLayout, item: PaneItem): PaneLayout {
  const at = columnOf(layout, item)
  if (at >= 0) return at === layout.focus ? layout : { ...layout, focus: at }
  if (layout.columns.length === 0) return { columns: [[item]], focus: 0, keys: [0] }
  if (layout.columns.length < MAX_COLUMNS) {
    const columns = [...layout.columns]
    const keys = [...layout.keys]
    columns.splice(layout.focus + 1, 0, [item])
    keys.splice(layout.focus + 1, 0, nextKey(layout.keys))
    return { columns, focus: layout.focus + 1, keys }
  }
  const target = layout.focus + 1 < layout.columns.length ? layout.focus + 1 : layout.focus - 1
  return { ...layout, columns: layout.columns.map((c, i) => (i === target ? [item] : c)), focus: target }
}

/**
 * ペインを閉じる。最後の 1 つは閉じない。フォーカスのあるペインを閉じたら左隣（左端なら新しい左端）へ移り、
 * それより左を閉じたら、フォーカスは同じペインを指したまま番号だけ詰める
 */
export function closeColumn(layout: PaneLayout, index: number): PaneLayout {
  if (layout.columns.length <= 1 || index < 0 || index >= layout.columns.length) return layout
  const columns = layout.columns.filter((_, i) => i !== index)
  const focus = index < layout.focus || (index === layout.focus && index > 0) ? layout.focus - 1 : layout.focus
  return { columns, focus, keys: layout.keys.filter((_, i) => i !== index) }
}

/** ペインにフォーカスを移す（ペインの中を押した） */
export function focusColumn(layout: PaneLayout, index: number): PaneLayout {
  return index === layout.focus || index < 0 || index >= layout.columns.length ? layout : { ...layout, focus: index }
}

/** 並んでいるセッションの ID（左から）。要対応のペインは含めない */
export function sessionIdsIn(layout: PaneLayout): string[] {
  return paneItems(layout).flatMap((item) => (item.kind === 'session' ? [item.id] : []))
}

/**
 * 隣のペインに開く（要対応の行からセッションへ飛ぶリンク）。開く元（フォーカスのあるペイン）は残り、フォーカスは開いた方へ移る。
 * - もう並びにあれば、そのペインにフォーカスを移すだけ
 * - 右隣があれば、その中身を入れ替える（行を順に開いていってもペインが増えていかない）
 * - 右隣が無ければ右に 1 つ足す。上限で足せなければ左隣の中身を入れ替える
 */
export function openInNeighbor(layout: PaneLayout, item: PaneItem): PaneLayout {
  const at = columnOf(layout, item)
  if (at >= 0) return at === layout.focus ? layout : { ...layout, focus: at }
  if (layout.columns.length === 0) return { columns: [[item]], focus: 0, keys: [0] }
  const right = layout.focus + 1
  if (right >= layout.columns.length && layout.columns.length < MAX_COLUMNS) {
    return { columns: [...layout.columns, [item]], focus: right, keys: [...layout.keys, nextKey(layout.keys)] }
  }
  const target = right < layout.columns.length ? right : layout.focus - 1
  if (target < 0) return placeItem(layout, item)
  return { ...layout, columns: layout.columns.map((c, i) => (i === target ? [item] : c)), focus: target }
}

/**
 * `%` で分けたとき、新しいペインに入れるセッション。**サイドバーの並び（`ids`）で、いまのセッションの次から探して
 * 最初の、まだ出していないもの**（末尾まで無ければ先頭に戻って探す）。いまが要対応・並びに無いセッションなら先頭から。
 * 出していないものが無ければ null（分けない）
 */
export function nextUnshown(ids: readonly string[], shown: readonly string[], from: string): string | null {
  const at = ids.indexOf(from)
  const order = at < 0 ? ids : [...ids.slice(at + 1), ...ids.slice(0, at)]
  return order.find((id) => !shown.includes(id)) ?? null
}
