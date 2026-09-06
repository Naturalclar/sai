import { useLayoutEffect, useRef } from 'react'
import type { RefObject } from 'react'

/**
 * 折りたたみを開いたとき、開いた中身が見えるところまでだけスクロールする。
 * `open` が false → true になった描画の直後（レイアウト後）に body を、true → false になったら anchor
 * （押したボタンのあった行）を `scrollIntoView({ block: 'nearest' })` する。
 * nearest なので、既に見えていれば動かず、下にはみ出していればその分だけ上がり、中身が画面より長ければ先頭が上端に来る。
 * スクロールするのは一番近い overflow の箱（チャットの `.chat`）で、読んでいた位置から飛ばさない。
 * 最初の描画（open の初期値）では動かない
 */
export function useReveal<B extends HTMLElement, A extends HTMLElement>(open: boolean): [RefObject<B | null>, RefObject<A | null>] {
  const body = useRef<B | null>(null)
  const anchor = useRef<A | null>(null)
  const prev = useRef(open)
  useLayoutEffect(() => {
    if (prev.current === open) return
    prev.current = open
    const el = open ? body.current : anchor.current
    // smooth にしない（展開の量が多いと遅い。prefers-reduced-motion も気にしなくてよい）
    el?.scrollIntoView({ block: 'nearest' })
  }, [open])
  // [開いた中身, 押したボタンのあった行]。タプルで返すのは、`x.body` の形だと lint が「描画中に ref を読んでいる」と見るため
  return [body, anchor]
}
