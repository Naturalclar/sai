import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type { DiffFile, DiffLine } from '../../shared/diff.ts'
import { HUNK_GAP, HUNK_HEADER_H, LINE_H, fileHeight, fileWidthCh, layoutFile, rowTop, rowsToRender, visibleRange, type ExtraHeights, type FileRow } from './diffVirtual.ts'
import { useScrollWatch, viewportOf } from './useScrollTick.ts'

/** ピン留めする行（コメントが付いている・編集中）。鍵は `${side}:${line}`。値はその行の下に描くもの */
export type PinnedRows = ReadonlyMap<string, ReactNode>

interface Props {
  file: DiffFile
  /** 行の描き方。コメントの口があるときは行番号がボタンになる（DiffFileItem が決める） */
  renderLine: (line: DiffLine, key: number) => ReactNode
  /** 行の下に描くもの（コメント・編集欄）。`${side}:${line}` → 要素。無ければ空 */
  pinned: PinnedRows
  /** 行のピン留めの鍵。行に付く側と番号の決め方は呼び出し側と同じ関数（lineAnchor） */
  pinKey: (line: DiffLine) => string
}

/**
 * 1 ファイルの本文（`.patch` の中身）。**見えている行 ± 余白だけを DOM に置く**（#287）。
 * - 行は固定の高さ（`LINE_H` / `HUNK_HEADER_H`。styles.css と揃える）で位置を計算し、`position: absolute` で置く。箱の高さは全行ぶん
 * - 見えていないファイルは高さだけの空箱（`rowsToRender` が空。ピン留めだけは置く）
 * - ピン留め（コメント付き・編集中）は見えていなくても置き、置いたあとに高さを測って（ResizeObserver）下の行の位置に足す
 * - 横幅は一番長い行の文字数から先に決める（`fileWidthCh`）。見えている行だけで `max-content` にすると横スクロールが跳ねる
 * どこが見えているかは `ScrollTick`（スクロール容器の scroll / resize）の合図で測り直し、**範囲が変わったときだけ描き直す**。
 * 行の並び・幅・ピン留めは file ごとに 1 回だけ組む（毎フレーム全行を数え直さない）
 */
export function DiffFilePatch({ file, renderLine, pinned, pinKey }: Props) {
  const ref = useRef<HTMLDivElement>(null)
  const { scroller, subscribe } = useScrollWatch()
  const layout = useMemo(() => layoutFile(file.hunks), [file])
  const widthCh = useMemo(() => fileWidthCh(file.hunks), [file])
  const [extra, setExtra] = useState<ExtraHeights>(new Map())
  const [range, setRange] = useState<[number, number]>([0, 0])

  // ピン留めの行の添字（行のコメントは side:line で付くので、行の並びから引く）。鍵の集合が同じなら組み直さない
  const pinKeys = [...pinned.keys()].sort().join(',')
  const pins = useMemo(() => {
    const out: number[] = []
    if (!pinKeys) return out
    const keys = new Set(pinKeys.split(','))
    layout.rows.forEach((r, i) => {
      if (r.kind === 'line' && keys.has(pinKey(file.hunks[r.hunk]!.lines[r.line]!))) out.push(i)
    })
    return out
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pinKeys, layout, file])

  // いま見えている範囲を測り直す。変わらなければ state を触らない（描き直さない）。
  // 合図（スクロール・resize）のたびと、file・ピン留めの高さが変わったとき
  const measure = useRef<() => void>(() => {})
  measure.current = () => {
    const el = ref.current
    if (!el) return
    const view = viewportOf(el, scroller)
    const next = visibleRange(layout.rows, view.top, view.bottom, extra)
    setRange((r) => (r[0] === next[0] && r[1] === next[1] ? r : next))
  }
  useLayoutEffect(() => {
    measure.current()
  }, [scroller, layout, extra])
  useEffect(() => subscribe(() => measure.current()), [subscribe])

  // ピン留めの高さを測る。行そのものの高さを引いた「余分」を、行の添字ごとに持つ
  const pinEls = useRef(new Map<number, HTMLDivElement>())
  useEffect(() => {
    if (typeof ResizeObserver !== 'function') return
    const ro = new ResizeObserver(() => {
      setExtra((prev) => {
        const next = new Map<number, number>()
        for (const [i, el] of pinEls.current) {
          const h = Math.max(0, Math.round(el.offsetHeight - LINE_H))
          if (h > 0) next.set(i, h)
        }
        if (next.size === prev.size && [...next].every(([k, v]) => prev.get(k) === v)) return prev
        return next
      })
    })
    for (const el of pinEls.current.values()) ro.observe(el)
    return () => ro.disconnect()
    // 観測する要素の集合が変わったら付け直す
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pins.join(','), file])

  const shown = rowsToRender(range, pins, layout.rows.length)
  const height = fileHeight(layout.height, extra)
  const pinSet = new Set(pins)

  const rowStyle = (r: FileRow, i: number) => ({ top: rowTop(layout.rows, i, extra), ...(r.kind === 'header' && r.hunk > 0 ? { marginTop: -HUNK_GAP } : {}) })

  return (
    <div className="vlist" ref={ref} style={{ height, width: `${widthCh}ch` }}>
      {shown.map((i) => {
        const r = layout.rows[i]!
        const hunk = file.hunks[r.hunk]!
        if (r.kind === 'header') {
          return (
            <div className={`hh${r.hunk > 0 ? ' next' : ''}`} key={`h${r.hunk}`} style={{ ...rowStyle(r, i), height: HUNK_HEADER_H + (r.hunk > 0 ? HUNK_GAP : 0) }}>
              {hunk.header}
            </div>
          )
        }
        const line = hunk.lines[r.line]!
        if (!pinSet.has(i)) {
          return (
            <div className="row" key={`${r.hunk}:${r.line}`} style={rowStyle(r, i)}>
              {renderLine(line, r.line)}
            </div>
          )
        }
        return (
          <div
            className="row pin"
            key={`${r.hunk}:${r.line}`}
            style={rowStyle(r, i)}
            ref={(el) => {
              if (el) pinEls.current.set(i, el)
              else pinEls.current.delete(i)
            }}
          >
            {renderLine(line, r.line)}
            {pinned.get(pinKey(line))}
          </div>
        )
      })}
    </div>
  )
}
