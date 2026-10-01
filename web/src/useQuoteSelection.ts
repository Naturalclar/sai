import { useEffect, useState } from 'react'
import type { RefObject } from 'react'
import { quotable, quoteButtonPosition } from './quoteReply'

/** いま引用できる選択。`left` / `top` はボタンを置く位置（viewport の座標） */
export interface QuotePick {
  text: string
  left: number
  top: number
}

/** 選択が外れてからボタンを消すまで（ms）。タッチ端末は、ボタンを押した瞬間に選択が外れてから click が届く */
const CLEAR_DELAY_MS = 250

const bubbleOf = (node: Node | null): Element | null => (node instanceof Element ? node : (node?.parentElement ?? null))?.closest('.msg') ?? null

/**
 * チャットの中で、1 つの返答のバブルの中の文字が選ばれているかを見る（#604）。判定は `quotable()`（純粋関数）。
 * `selectionchange` とスクロールで読み直す（ボタンは fixed なので、スクロールで位置がずれる）。`enabled` が false なら何もしない
 */
export function useQuoteSelection(container: RefObject<HTMLElement | null>, enabled: boolean): { pick: QuotePick | null; clear: () => void } {
  const [pick, setPick] = useState<QuotePick | null>(null)
  useEffect(() => {
    if (!enabled) return
    let timer: ReturnType<typeof setTimeout> | undefined
    const read = () => {
      const sel = document.getSelection()
      const root = container.current
      const drop = () => {
        clearTimeout(timer)
        timer = setTimeout(() => setPick(null), CLEAR_DELAY_MS)
      }
      if (!sel || sel.isCollapsed || sel.rangeCount === 0 || !root) return drop()
      const from = bubbleOf(sel.anchorNode)
      const to = bubbleOf(sel.focusNode)
      const text = sel.toString()
      const ok = from !== null && root.contains(from) && quotable({ sameBubble: from === to, side: from.getAttribute('data-side') ?? '', waiting: from.classList.contains('waiting'), text })
      if (!ok) return drop()
      clearTimeout(timer)
      const rect = sel.getRangeAt(0).getBoundingClientRect()
      setPick({ text, ...quoteButtonPosition(rect, { width: window.innerWidth, height: window.innerHeight }) })
    }
    document.addEventListener('selectionchange', read)
    window.addEventListener('scroll', read, true)
    window.addEventListener('resize', read)
    return () => {
      clearTimeout(timer)
      document.removeEventListener('selectionchange', read)
      window.removeEventListener('scroll', read, true)
      window.removeEventListener('resize', read)
    }
  }, [container, enabled])
  return {
    pick: enabled ? pick : null,
    clear: () => {
      document.getSelection()?.removeAllRanges()
      setPick(null)
    },
  }
}
