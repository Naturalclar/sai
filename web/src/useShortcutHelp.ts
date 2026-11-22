import { useCallback, useEffect, useState } from 'react'
import { isTypingTarget } from './sessionNav'
import { helpAction } from './shortcuts'

/**
 * キーボードショートカットの一覧（#910）の開閉。`?`（入力欄の外）で開閉し、開いているときの `Esc` で閉じる。
 * keydown は **capture** で拾い、拾ったものだけ止める: 開いているときの `Esc` を App の「フィードへ」に渡さないため
 * （`useDismiss` と同じ理由）。判定は `helpAction()`
 */
export function useShortcutHelp() {
  const [open, setOpen] = useState(false)

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      // 開いているパネル自身（.shortcut-help）は「ほかのモーダル」に数えない
      const modal = document.querySelector('.modal-backdrop:not(.shortcut-help-backdrop)') !== null
      const action = helpAction(e, { typing: isTypingTarget(e.target as HTMLElement | null), open, modal })
      if (!action) return
      e.preventDefault()
      e.stopPropagation()
      setOpen(action === 'toggle' ? !open : false)
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [open])

  const show = useCallback(() => setOpen(true), [])
  const close = useCallback(() => setOpen(false), [])
  return { open, show, close }
}
