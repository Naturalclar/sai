import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type { DiffFile, DiffLine } from '../../shared/diff.ts'
import { lineAnchor } from './diffComments'
import { OVERSCAN_PX, fileHeight, fileWidthCh, layoutFile, rowTop, rowsToRender, visibleRange, type ExtraHeights, type FileRow } from './diffVirtual.ts'
import { useScrollWatch, viewportOf } from './useScrollTick.ts'

/** ピン留めする行（コメントが付いている・編集中）。鍵は `${side}:${line}`。値はその行の下に描くもの */
export type PinnedRows = ReadonlyMap<string, ReactNode>

/** ピン留めの鍵。行に付く側と番号は行コメントと同じ決め方（lineAnchor） */
export const pinKey = (l: DiffLine): string => {
  const a = lineAnchor(l)
  return `${a.side}:${a.line}`
}

interface Props {
  file: DiffFile
  /** 行の描き方。コメントの口があるときは行番号がボタンになる（DiffFileItem が決める） */
  renderLine: (line: DiffLine) => ReactNode
  /** 行の下に描くもの（コメント・編集欄）。`${side}:${line}` → 要素。無ければ空 */
  pinned: PinnedRows
}

/**
 * 1 ファイルの本文（`.patch` の中身）。**見えている行 ± 余白だけを DOM に置く**（#287）。
 * - 行は固定の高さ（`LINE_H` / `HUNK_HEADER_H`。styles.css と揃える）で位置を計算し、`position: absolute` で置く。箱の高さは全行ぶん
 * - 見えていないファイルは高さだけの空箱（`rowsToRender` が空。ピン留めだけは置く）
 * - ピン留め（コメント付き・編集中）は見えていなくても置き、置いた直後に高さを測って（描く前に。`useLayoutEffect`）下の行の位置に足す。
 *   その後の高さの変化（欄に文字を打つなど）は ResizeObserver で追う
 * - 横幅は一番長い行の文字数から先に決める（`fileWidthCh`）。見えている行だけで `max-content` にすると横スクロールが跳ねる
 * どこが見えているかは、スクロール容器の合図（`ScrollTick`）と、この箱自身が見えた・隠れた合図（IntersectionObserver。
 * 上のファイルの開閉のようにスクロールせずに位置がずれたときはこちらが拾う）で測り直す。描く範囲は render の中で導く
 * （state に持つのは「測り直したら範囲が変わった」の回数だけ）
 */
export function DiffFilePatch({ file, renderLine, pinned }: Props) {
  const ref = useRef<HTMLDivElement>(null)
  const { scrollerRef, subscribe } = useScrollWatch()
  const layout = useMemo(() => layoutFile(file.hunks), [file])
  const widthCh = useMemo(() => fileWidthCh(file.hunks), [file])
  const [extra, setExtra] = useState<ExtraHeights>(new Map())

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

  // 最後に測った見えている範囲（この箱の先頭を 0 とした px）。描く範囲は render のたびにここから導く
  const view = useRef<{ top: number; bottom: number } | null>(null)
  const rendered = useRef<[number, number]>([0, 0])
  const [, bump] = useState(0)
  const measure = useRef<() => void>(() => {})
  measure.current = () => {
    const el = ref.current
    if (!el) return
    view.current = viewportOf(el, scrollerRef.current)
    const next = visibleRange(layout.rows, view.current.top, view.current.bottom, extra)
    const cur = rendered.current
    if (cur[0] === next[0] && cur[1] === next[1]) return
    // 抜ける行にフォーカスがあれば箱に移す（モーダルの中に留める。Esc とタブ順が body に落ちない）
    const active = document.activeElement
    if (active && el.contains(active)) {
      const i = Number(active.closest<HTMLElement>('[data-i]')?.dataset.i ?? -1)
      if (i >= 0 && (i < next[0] || i >= next[1]) && !pins.includes(i)) el.focus({ preventScroll: true })
    }
    bump((v) => v + 1)
  }
  // 合図: スクロール容器の scroll / resize と、この箱が見えた・隠れた（スクロール無しの位置ずれ）
  useEffect(() => subscribe(() => measure.current()), [subscribe])
  useEffect(() => {
    const el = ref.current
    if (!el || typeof IntersectionObserver !== 'function') return
    // 親の layout effect が容器を決めたあとに走る（passive effect）。observe した直後に 1 回鳴るので、最初の測定もこれ
    const io = new IntersectionObserver(() => measure.current(), { root: scrollerRef.current, rootMargin: `${OVERSCAN_PX}px 0px` })
    io.observe(el)
    return () => io.disconnect()
  }, [scrollerRef])

  // ピン留めの高さ。行そのものの高さを引いた「余分」を、行の添字ごとに持つ。
  // 置いた直後（描く前）に測る: 測らないと下の行が編集欄の上に 1 フレーム重なる。**DOM の高さは描かないと分からないので、
  // ここだけは layout effect の中で state を書く**（描画中には導けない）。ピン留めが無くなったら空に戻す（ResizeObserver は
  // 観測する要素が無いと鳴らないので、古い余分が残る）
  const pinEls = useRef(new Map<number, HTMLDivElement>())
  const read = (): ExtraHeights => {
    const next = new Map<number, number>()
    for (const [i, el] of pinEls.current) {
      const line = el.firstElementChild as HTMLElement | null
      const h = Math.max(0, Math.round(el.offsetHeight - (line?.offsetHeight ?? 0)))
      if (h > 0) next.set(i, h)
    }
    return next
  }
  const same = (a: ExtraHeights, b: ExtraHeights) => a.size === b.size && [...a].every(([k, v]) => b.get(k) === v)
  const pinsKey = pins.join(',')
  useLayoutEffect(() => {
    const next = pins.length ? read() : new Map<number, number>()
    setExtra((prev) => (same(prev, next) ? prev : next))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pinsKey, file])
  useEffect(() => {
    if (!pins.length || typeof ResizeObserver !== 'function') return
    const ro = new ResizeObserver(() => {
      const next = read()
      setExtra((prev) => (same(prev, next) ? prev : next))
    })
    for (const el of pinEls.current.values()) ro.observe(el)
    return () => ro.disconnect()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pinsKey, file])

  const range = view.current ? visibleRange(layout.rows, view.current.top, view.current.bottom, extra) : ([0, 0] as [number, number])
  rendered.current = range
  const shown = rowsToRender(range, pins, layout.rows.length)
  const height = fileHeight(layout.height, extra)
  const pinSet = new Set(pins)
  const rowStyle = (r: FileRow, i: number) => ({ top: rowTop(layout.rows, i, extra), height: r.height })

  return (
    <div className="vlist" ref={ref} tabIndex={-1} style={{ height, width: `${widthCh}ch` }}>
      {shown.map((i) => {
        const r = layout.rows[i]!
        const hunk = file.hunks[r.hunk]!
        if (r.kind === 'header') {
          return (
            <div className={`hh${r.hunk > 0 ? ' next' : ''}`} key={`h${r.hunk}`} style={rowStyle(r, i)}>
              {hunk.header}
            </div>
          )
        }
        const line = hunk.lines[r.line]!
        if (!pinSet.has(i)) {
          return (
            <div className="row" key={`${r.hunk}:${r.line}`} data-i={i} style={rowStyle(r, i)}>
              {renderLine(line)}
            </div>
          )
        }
        return (
          <div
            className="row pin"
            key={`${r.hunk}:${r.line}`}
            data-i={i}
            style={{ top: rowTop(layout.rows, i, extra) }}
            ref={(el) => {
              if (el) pinEls.current.set(i, el)
              else pinEls.current.delete(i)
            }}
          >
            {renderLine(line)}
            {pinned.get(pinKey(line))}
          </div>
        )
      })}
    </div>
  )
}
