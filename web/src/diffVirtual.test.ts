import { test } from 'node:test'
import assert from 'node:assert/strict'
import { HUNK_GAP, HUNK_HEADER_H, LINE_H, charWidth, fileHeight, fileWidthCells, layoutFile, rowTop, rowsToRender, textWidth, visibleRange } from './diffVirtual.ts'

const hunks = (...sizes: number[]) => sizes.map((n) => ({ header: '@@', lines: Array.from({ length: n }, (_, i) => ({ text: `l${i}` })) }))

test('layoutFile: 見出しと行を上から平らに並べ、固定の高さで位置を組む', () => {
  const { rows, height } = layoutFile(hunks(2, 1))
  assert.deepEqual(
    rows.map((r) => [r.kind, r.hunk, r.line, r.top]),
    [
      ['header', 0, -1, 0],
      ['line', 0, 0, HUNK_HEADER_H],
      ['line', 0, 1, HUNK_HEADER_H + LINE_H],
      ['header', 1, -1, HUNK_HEADER_H + LINE_H * 2],
      ['line', 1, 0, HUNK_HEADER_H * 2 + LINE_H * 2 + HUNK_GAP],
    ],
  )
  assert.equal(rows[3]!.height, HUNK_HEADER_H + HUNK_GAP, '2 つ目の見出しは罫線ぶん高い')
  assert.equal(height, HUNK_HEADER_H * 2 + LINE_H * 3 + HUNK_GAP)
  assert.deepEqual(layoutFile([]), { rows: [], height: 0 })
})

test('visibleRange: 見えている範囲 ± 余白の行だけ。上下に余白、端で止まる、見えていなければ空', () => {
  const { rows } = layoutFile(hunks(1000))
  // 見出し 20.5 + 行 18 ずつ。100 行目あたりを見ている（余白 0）
  const top = HUNK_HEADER_H + LINE_H * 100
  const [from, to] = visibleRange(rows, top, top + LINE_H * 10, new Map(), 0)
  assert.equal(from, 101, '100 行目（添字 101。見出しが 0）から')
  assert.equal(to, 111, '10 行ぶん')
  // 余白を足すと広がる
  const [f2, t2] = visibleRange(rows, top, top + LINE_H * 10, new Map(), LINE_H * 5)
  assert.deepEqual([f2, t2], [96, 116])
  // 先頭で止まる
  assert.deepEqual(visibleRange(rows, 0, LINE_H * 3, new Map(), 1000), [0, Math.ceil((LINE_H * 3 + 1000 - HUNK_HEADER_H) / LINE_H) + 1])
  // 末尾で止まる
  assert.equal(visibleRange(rows, LINE_H * 990, LINE_H * 2000, new Map(), 0)[1], rows.length)
  // 見えていない（ファイルより下、または上）
  assert.deepEqual(visibleRange(rows, LINE_H * 5000, LINE_H * 5100, new Map(), 0), [0, 0])
  assert.deepEqual(visibleRange(rows, -5000, -4000, new Map(), 0), [0, 0])
  assert.deepEqual(visibleRange(rows, 10, 10, new Map(), 0), [0, 0], '高さ 0 の窓')
  // 丸ごと上に外れたファイル（ピン留めの余分な高さの分まで見てから外れたと判断する）
  const { rows: r2, height: h2 } = layoutFile(hunks(10))
  assert.deepEqual(visibleRange(r2, h2 + 1, h2 + 500, new Map(), 0), [0, 0])
  assert.notDeepEqual(visibleRange(r2, h2 + 1, h2 + 500, new Map([[9, 100]]), 0), [0, 0], 'コメントの分だけ下に伸びている')
  assert.deepEqual(visibleRange([], 0, 100), [0, 0])
})

test('visibleRange / rowTop / fileHeight: ピン留めの余分な高さで、その下の行はずれる', () => {
  const { rows, height } = layoutFile(hunks(100))
  const extra = new Map([[10, 90]]) // 添字 10（9 行目）の下にコメント 90px
  assert.equal(rowTop(rows, 10, extra), rows[10]!.top, '本人はずれない')
  assert.equal(rowTop(rows, 11, extra), rows[11]!.top + 90, '下の行は 90 下がる')
  assert.equal(rowTop(rows, 5, extra), rows[5]!.top, '上の行は変わらない')
  assert.equal(fileHeight(height, extra), height + 90)
  // 添字 11 の元の位置には、まだ添字 10 の箱（行 + コメント 90px）がある。添字 11 は 90 下から
  const at = rows[11]!.top
  assert.deepEqual(visibleRange(rows, at, at + LINE_H, extra, 0), [10, 11])
  assert.deepEqual(visibleRange(rows, at + 90, at + 90 + LINE_H, extra, 0), [11, 12])
})

test('rowsToRender: 見えている範囲にピン留めを足して昇順。範囲外のピンは落とす', () => {
  assert.deepEqual(rowsToRender([5, 8], [2, 6, 40, -1, 100], 50), [2, 5, 6, 7, 40])
  assert.deepEqual(rowsToRender([0, 0], [], 10), [])
})

test('charWidth / textWidth: 全角と絵文字は 2、半角は 1、結合と制御は 0、タブは 8 桁', () => {
  assert.equal(textWidth('abc'), 3)
  assert.equal(textWidth('あいう'), 6)
  assert.equal(textWidth('ｱｲ'), 2, '半角カナは 1')
  assert.equal(textWidth('Ａ１'), 4, '全角英数は 2')
  assert.equal(textWidth('한글'), 4)
  assert.equal(textWidth('🚀'), 2)
  assert.equal(textWidth('✅❌⭐⏰🀄'), 10, '絵文字として描かれる記号も 2')
  assert.equal(textWidth('※①'), 4, '等幅に無い記号（別の書体で約 1em）は 2（#611）')
  assert.equal(textWidth('●─→'), 3, '罫線・矢印・幾何はコーディング用の等幅が 1 セルで持つので 1')
  assert.equal(textWidth('├── src/'), 8)
  assert.equal(textWidth('é'), 1, '結合記号は 0')
  assert.equal(textWidth('a\tb'), 9)
  assert.equal(textWidth('abcdefgh\tb'), 17, 'タブは次の 8 桁へ')
  assert.equal(charWidth(0x1b), 0)
  assert.equal(textWidth(''), 0)
})

test('fileWidthCells: 行と見出しそれぞれの一番長い文字幅（セル数）。px にするのは CSS', () => {
  assert.deepEqual(fileWidthCells([{ header: '@@ -1 +1 @@', lines: [{ text: 'short' }, { text: 'x'.repeat(100) }, { text: 'あ'.repeat(30) }] }]), { cols: 100, hcols: 11 })
  assert.deepEqual(fileWidthCells([{ header: '@@', lines: [{ text: 'あ'.repeat(60) }] }]), { cols: 120, hcols: 2 }, '全角 60 字 = 120')
  const long = '@@ -1,3 +1,4 @@ ' + 'h'.repeat(200)
  assert.deepEqual(fileWidthCells([{ header: long, lines: [{ text: 'a' }] }]), { cols: 1, hcols: textWidth(long) })
  assert.deepEqual(fileWidthCells([]), { cols: 0, hcols: 0 })
})
