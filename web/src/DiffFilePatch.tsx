import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties, ReactNode } from 'react'
import type { DiffFile, DiffLine } from '../../shared/diff.ts'
import { lineAnchor } from './diffComments'
import { OVERSCAN_PX, fileHeight, fileWidthCells, layoutFile, rowTop, rowsToRender, visibleRange, type ExtraHeights, type FileRow } from './diffVirtual.ts'
import { useScrollWatch, viewportOf } from './useScrollTick.ts'

/** ピン留めの鍵（`${side}:${line}`）。行に付く側と番号は行コメントと同じ決め方（lineAnchor）。作るのはこの関数だけ */
export const pinKey = (l: Pick<DiffLine, 'oldNo' | 'newNo' | 'kind'>): string => {
  const a = lineAnchor(l as DiffLine)
  return `${a.side}:${a.line}`
}

interface Props {
  file: DiffFile
  /** 行の描き方。`pinned` が true の行には、行の下に描くもの（コメント・編集欄）も続けて返す */
  renderLine: (line: DiffLine, pinned: boolean) => ReactNode
  /** 見えていなくても常に置く行の鍵（`pinKey()`）。コメントが付いている行と編集中の行 */
  pinned: ReadonlySet<string>
}

const NO_VIEW = [0, 0] as [number, number]

/**
 * 1 ファイルの本文（`.patch` の中身）。**見えている行 ± 余白だけを DOM に置く**（#287）。
 * - 行は固定の高さ（`LINE_H` / `HUNK_HEADER_H`。styles.css と揃える）で位置を計算し、`position: absolute` で置く。箱の高さは全行ぶん
 * - 見えていないファイルは高さだけの空箱（`rowsToRender` が空。ピン留めだけは置く）
 * - ピン留め（コメント付き・編集中）は見えていなくても置き、描く前に高さを測って（`useLayoutEffect`）下の行の位置に足す。
 *   その後の高さの変化（欄に文字を打つなど）は ResizeObserver で追う
 * - 横幅は一番長い行の文字数から先に決める（`fileWidthCells` → CSS の `--cols` / `--hcols`）。見えている行だけで `max-content` にすると横スクロールが跳ねる
 * どこが見えているかは、スクロール容器の合図（`ScrollTick`。scroll / resize / 根の高さの変化）と、この箱自身が見えた・隠れた合図
 * （IntersectionObserver）で測り直す。描く範囲は render の中で導く（state に持つのは「測り直したら範囲が変わった」の回数だけ）
 */
export function DiffFilePatch({ file, renderLine, pinned }: Props) {
  const ref = useRef<HTMLDivElement>(null)
  const { scrollerRef, subscribe } = useScrollWatch()
  const layout = useMemo(() => layoutFile(file.hunks), [file])
  const cells = useMemo(() => fileWidthCells(file.hunks), [file])
  const [extra, setExtra] = useState<ExtraHeights>(new Map())

  // ピン留めの行の添字（鍵は side:line なので、行の並びから引く）。鍵の集合が同じなら組み直さない
  const pins = useMemo(() => {
    const out = new Set<number>()
    if (pinned.size === 0) return out
    layout.rows.forEach((r, i) => {
      if (r.kind === 'line' && pinned.has(pinKey(file.hunks[r.hunk]!.lines[r.line]!))) out.add(i)
    })
    return out
  }, [pinned, layout, file])

  // 最後に測った見えている範囲（この箱の先頭を 0 とした px）。描く範囲は render のたびにここから導く
  const view = useRef<{ top: number; bottom: number } | null>(null)
  const rendered = useRef<[number, number]>(NO_VIEW)
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
      if (i >= 0 && (i < next[0] || i >= next[1]) && !pins.has(i)) el.focus({ preventScroll: true })
    }
    bump((v) => v + 1)
  }
  // 最初の描画で行を出す（#611）。測らないと、ファイルを開いた瞬間に全高の空箱が 1 フレーム出てから行が入る。
  // 親の layout effect（容器を決める）より先に走るので窓基準の近似だが、直後の IntersectionObserver の初回通知で正される。
  // layout effect の中で state を書く例外（DOM の位置は描かないと分からない）
  useLayoutEffect(() => {
    measure.current()
  }, [])
  // 合図: スクロール容器の scroll / resize / 根の高さの変化と、この箱が見えた・隠れた
  useEffect(() => subscribe(() => measure.current()), [subscribe])
  useEffect(() => {
    const el = ref.current
    if (!el || typeof IntersectionObserver !== 'function') return
    // 親の layout effect が容器を決めたあとに走る（passive effect）。observe した直後に 1 回鳴る
    const io = new IntersectionObserver(() => measure.current(), { root: scrollerRef.current, rootMargin: `${OVERSCAN_PX}px 0px` })
    io.observe(el)
    return () => io.disconnect()
  }, [scrollerRef])

  // ピン留めの高さ。行そのものの高さを引いた「余分」を、行の添字ごとに持つ。
  // **描く前に測る**（測らないと下の行が編集欄の上に 1 フレーム重なる）。鍵が同じまま中身が変わる（編集欄 → 保存したコメント）ことが
  // あるので、`renderLine` が変わるたび（= DiffFileItem が描き直るたび）に測り、同じなら state を触らない（#611）。**DOM の高さは描かないと分からないので、ここは layout effect の中で
  // state を書く例外**。ピン留めが無くなったら空に戻す（ResizeObserver は観測する要素が無いと鳴らないので、古い余分が残る）
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
  useLayoutEffect(() => {
    const next = pins.size ? read() : new Map<number, number>()
    setExtra((prev) => (same(prev, next) ? prev : next))
    // renderLine は DiffFileItem が描き直るたびに新しくなる = ピン留めの中身（編集欄 → コメント）が変わりうるとき
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pins, file, renderLine])
  useEffect(() => {
    if (!pins.size || typeof ResizeObserver !== 'function') return
    const ro = new ResizeObserver(() => {
      const next = read()
      setExtra((prev) => (same(prev, next) ? prev : next))
    })
    for (const el of pinEls.current.values()) ro.observe(el)
    return () => ro.disconnect()
    // 観測する要素の集合（= ピン留めの添字）が変わったら付け直す
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pins, file])

  const range = view.current ? visibleRange(layout.rows, view.current.top, view.current.bottom, extra) : NO_VIEW
  rendered.current = range
  const shown = rowsToRender(range, pins, layout.rows.length)
  const height = fileHeight(layout.height, extra)
  const rowStyle = (r: FileRow, i: number) => ({ top: rowTop(layout.rows, i, extra), height: r.height })
  const boxStyle = { height, '--cols': cells.cols, '--hcols': cells.hcols } as CSSProperties

  return (
    <div className="vlist" ref={ref} tabIndex={-1} style={boxStyle}>
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
        if (!pins.has(i)) {
          return (
            <div className="row" key={`${r.hunk}:${r.line}`} data-i={i} style={rowStyle(r, i)}>
              {renderLine(line, false)}
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
            {renderLine(line, true)}
          </div>
        )
      })}
    </div>
  )
}
