import { useRef, useState } from 'react'
import type { PointerEvent } from 'react'
import { clampOffset, isHorizontal, RAIL_WIDTH, swipeState } from './swipe.ts'

interface Options {
  /** タッチ端末のときだけ true。false なら何もしない（マウスとキーボードの経路は今まで通り） */
  enabled: boolean
  /** いま開いているか（開いている項目は一覧で 1 つだけなので、呼び出し側が持つ） */
  open: boolean
  onOpenChange: (open: boolean) => void
  /** 深く引いて離したとき（そのまま実行） */
  onCommit: () => void
  /** 動きを追わず、しきい値で即座に開閉する（prefers-reduced-motion） */
  reduced: boolean
}

export interface SwipeHandle {
  /** 項目の <a> に付ける横ずれ（px、左が負） */
  dx: number
  /** 指で追っている最中（transition を切る） */
  dragging: boolean
  /** 直前のスワイプで動いた。続く click はリンクを動かさない */
  swiped: () => boolean
  onPointerDown: (e: PointerEvent<HTMLElement>) => void
  onPointerMove: (e: PointerEvent<HTMLElement>) => void
  onPointerUp: (e: PointerEvent<HTMLElement>) => void
  onPointerCancel: (e: PointerEvent<HTMLElement>) => void
}

/**
 * 項目を左にスワイプして、右からレール（アーカイブ）を出す。
 * 指が動き始めて横 > 縦 と分かってから横だけ追い、縦ならスクロールに任せる（要素には touch-action: pan-y）。
 * 離したときは swipe.ts の swipeState で closed / open / commit を決める。開いた状態からさらに左へも引ける
 */
export function useSwipe({ enabled, open, onOpenChange, onCommit, reduced }: Options): SwipeHandle {
  const [drag, setDrag] = useState<{ dx: number } | null>(null)
  const start = useRef<{ id: number; x: number; y: number; width: number; horizontal: boolean | null } | null>(null)
  const lastSwiped = useRef(false)

  const base = open ? -RAIL_WIDTH : 0

  const onPointerDown = (e: PointerEvent<HTMLElement>) => {
    if (!enabled || e.pointerType === 'mouse' || !e.isPrimary) return
    lastSwiped.current = false
    start.current = { id: e.pointerId, x: e.clientX, y: e.clientY, width: e.currentTarget.clientWidth, horizontal: null }
  }

  const onPointerMove = (e: PointerEvent<HTMLElement>) => {
    const s = start.current
    if (!s || s.id !== e.pointerId) return
    const dx = e.clientX - s.x
    const dy = e.clientY - s.y
    if (s.horizontal === null) {
      s.horizontal = isHorizontal(dx, dy)
      if (s.horizontal === false) {
        start.current = null // 縦。以後はスクロールに任せる
        return
      }
      if (s.horizontal === true) {
        try {
          e.currentTarget.setPointerCapture(e.pointerId)
        } catch {
          // 取れなくても追える範囲で追う
        }
      }
    }
    if (s.horizontal !== true) return
    lastSwiped.current = true
    if (!reduced) setDrag({ dx: clampOffset(base + dx, s.width) })
  }

  const finish = (e: PointerEvent<HTMLElement>) => {
    const s = start.current
    if (!s || s.id !== e.pointerId) return
    start.current = null
    setDrag(null)
    if (s.horizontal !== true) return
    const dx = clampOffset(base + (e.clientX - s.x), s.width)
    const state = swipeState(dx, s.width)
    if (state === 'commit') {
      onCommit()
      return
    }
    onOpenChange(state === 'open')
  }

  const onPointerCancel = (e: PointerEvent<HTMLElement>) => {
    const s = start.current
    if (!s || s.id !== e.pointerId) return
    start.current = null
    setDrag(null)
  }

  return {
    dx: drag ? drag.dx : base,
    dragging: drag !== null,
    swiped: () => lastSwiped.current,
    onPointerDown,
    onPointerMove,
    onPointerUp: finish,
    onPointerCancel,
  }
}
