import { createContext, useContext, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { RefObject } from 'react'

/**
 * 差分ビューアの仮想化（#287）が「いま何が見えているか」を測り直す合図。スクロール容器（`.diff-scroll` など。無ければ window）の
 * scroll と resize を 1 か所で受け、rAF ごとに 1 回だけ購読者に知らせる。ファイルごとの部品（`DiffFilePatch`）は購読して
 * 自分の位置を `getBoundingClientRect()` で測り直し、**描く範囲が変わったときだけ**描き直す。
 * React の state で数を進める形にすると、1 フレームごとに全ファイルが描き直される（実測で 4 倍の CPU 絞りで 1 フレーム 67ms）。
 * 容器は ref に持つ（state にすると effect の中で setState になる。読むのは購読者の callback と effect の中だけ）
 */
export interface ScrollWatch {
  /** スクロール容器。無ければ window。render の中では読まない（callback / effect で読む） */
  scrollerRef: RefObject<HTMLElement | null>
  /** 合図の購読。戻り値で解除 */
  subscribe: (fn: () => void) => () => void
}

const NONE: ScrollWatch = { scrollerRef: { current: null }, subscribe: () => () => {} }
export const ScrollTick = createContext<ScrollWatch>(NONE)

/** el の祖先で縦にスクロールする要素（overflow-y が auto / scroll）。無ければ null（= window） */
export function findScroller(el: HTMLElement | null): HTMLElement | null {
  for (let p = el?.parentElement ?? null; p; p = p.parentElement) {
    const oy = getComputedStyle(p).overflowY
    if (oy === 'auto' || oy === 'scroll') return p
  }
  return null
}

/**
 * `ref` の祖先のスクロール容器を見つけ、その scroll / window の resize を 1 か所で受けて配る。
 * layout effect で決める: 子（`DiffFilePatch`）の passive effect はこの後に走るので、そこで容器が読める
 */
export function useScrollTick(ref: RefObject<HTMLElement | null>): ScrollWatch {
  const scrollerRef = useRef<HTMLElement | null>(null)
  const [listeners] = useState(() => new Set<() => void>())
  useLayoutEffect(() => {
    const scroller = findScroller(ref.current)
    scrollerRef.current = scroller
    const target: HTMLElement | Window = scroller ?? window
    let raf = 0
    const bump = () => {
      if (raf) return
      raf = requestAnimationFrame(() => {
        raf = 0
        for (const fn of listeners) fn()
      })
    }
    target.addEventListener('scroll', bump, { passive: true })
    window.addEventListener('resize', bump)
    // 容器の大きさ（ペインの幅・キーボードの出入り）が変わっても測り直す
    const ro = scroller && typeof ResizeObserver === 'function' ? new ResizeObserver(bump) : null
    ro?.observe(scroller!)
    bump()
    return () => {
      target.removeEventListener('scroll', bump)
      window.removeEventListener('resize', bump)
      ro?.disconnect()
      if (raf) cancelAnimationFrame(raf)
      scrollerRef.current = null
    }
  }, [ref, listeners])
  return useMemo(
    () => ({
      scrollerRef,
      subscribe: (fn: () => void) => {
        listeners.add(fn)
        return () => {
          listeners.delete(fn)
        }
      },
    }),
    [listeners],
  )
}

/** 部品側。`ScrollTick` の中に居なければ合図は来ない（テストや、仮想化しない場所） */
export function useScrollWatch(): ScrollWatch {
  return useContext(ScrollTick)
}

/**
 * 要素 `el` の中で見えている縦の範囲（`el` の先頭を 0 とした px）。容器が無ければ window。
 * 見えていなければ負や高さ超えの値になる（`visibleRange()` が空を返す）
 */
export function viewportOf(el: HTMLElement, scroller: HTMLElement | null): { top: number; bottom: number } {
  const box = el.getBoundingClientRect()
  if (scroller) {
    const c = scroller.getBoundingClientRect()
    return { top: c.top - box.top, bottom: c.top - box.top + scroller.clientHeight }
  }
  return { top: -box.top, bottom: -box.top + window.innerHeight }
}
