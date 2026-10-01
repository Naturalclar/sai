import { useEffect, useState } from 'react'
import type { RefObject } from 'react'
import { quotable, quoteButtonPosition, selectionVisible } from './quoteReply'

/** いま引用できる選択。`left` / `top` はボタンを置く位置（viewport の座標） */
export interface QuotePick {
  text: string
  left: number
  top: number
}

/** 選択が外れてからボタンを消すまで（ms）。タッチ端末は、ボタンを押した瞬間に選択が外れてから click が届く */
const CLEAR_DELAY_MS = 250

/**
 * その場所を含む**返答の本文**（`.msg` の中の `.body`）。一言（`.summary`）・思考・時刻・使用量の印・ボタンの文字は本文ではないので引かない
 * （一言は LLM の言い換えで、エージェントが書いた文ではない。引用しても何を指しているか伝わらない）
 */
const bodyOf = (node: Node | null): Element | null => (node instanceof Element ? node : (node?.parentElement ?? null))?.closest('.msg .body') ?? null

/**
 * チャットの中で、1 つの返答の**本文**（`.body`）の中の文字が選ばれているかを見る（#604）。判定は `quotable()`（純粋関数）。
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
      const from = bodyOf(sel.anchorNode)
      const to = bodyOf(sel.focusNode)
      const bubble = from?.closest('.msg') ?? null
      const text = sel.toString()
      const ok = from !== null && bubble !== null && root.contains(bubble) && quotable({ sameBubble: from === to, side: bubble.getAttribute('data-side') ?? '', waiting: bubble.classList.contains('waiting'), text })
      if (!ok) return drop()
      const rect = sel.getRangeAt(0).getBoundingClientRect()
      if (!selectionVisible(rect, root.getBoundingClientRect())) return drop()
      clearTimeout(timer)
      const next = { text, ...quoteButtonPosition(rect, { width: window.innerWidth, height: window.innerHeight }) }
      // 同じ選択・同じ位置なら state を触らない（スクロールのたびにチャット全体を描き直さない）
      setPick((prev) => (prev && prev.text === next.text && prev.left === next.left && prev.top === next.top ? prev : next))
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
