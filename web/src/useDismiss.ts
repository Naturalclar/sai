import { useEffect } from 'react'
import type { RefObject } from 'react'

/**
 * 開いているメニューを、外側を押したときと Esc で閉じる（ヘッダの UserMenu と、狭い画面の見出しの「⋯」。#274）。
 * - **外側を押したら、中でフォーカスしている欄を先に blur してから閉じる**。閉じると中身ごと消えるので、
 *   欄を離れたときに保存する入力（Linear の workspace）が blur を受け取れず、書きかけが消える
 * - **Esc は capture で拾って止める**。App のセッション移動は window の bubble で Esc を「フィードへ」と読むので、
 *   止めないとメニューを閉じるついでに画面まで移る（FeedProjectPicker と同じ理由）
 * - 中で開いたモーダル（`.modal-backdrop`。ポータルを使わないので DOM ではメニューの中）の Esc はモーダルに任せる
 * - 押したかどうかは `pointerdown` で見る（タッチでも必ず飛ぶ。`mousedown` はタッチの後から互換で飛ぶだけ）
 */
export function useDismiss(ref: RefObject<HTMLElement | null>, open: boolean, setOpen: (open: boolean) => void): void {
  useEffect(() => {
    if (!open) return
    const onDown = (e: PointerEvent) => {
      const root = ref.current
      if (!root || root.contains(e.target as Node)) return
      const focused = document.activeElement
      if (focused instanceof HTMLElement && root.contains(focused)) focused.blur()
      setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      if (e.target instanceof Element && e.target.closest('.modal-backdrop')) return
      e.preventDefault()
      e.stopPropagation()
      setOpen(false)
    }
    document.addEventListener('pointerdown', onDown)
    document.addEventListener('keydown', onKey, true)
    return () => {
      document.removeEventListener('pointerdown', onDown)
      document.removeEventListener('keydown', onKey, true)
    }
  }, [ref, open, setOpen])
}
