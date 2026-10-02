import type { MouseEvent } from 'react'
import { SplitMark } from './SplitMark'

/**
 * サイドバーの項目の右上に出る「横に並べて開く」（#633）。⌘ + クリックと同じことをマウスだけでする。
 * 項目のリンクとは別の要素なので、押してもフォーカスのあるペインの中身は入れ替わらない
 */
export function SessionSplitButton({ onOpen }: { onOpen: () => void }) {
  const onClick = (e: MouseEvent<HTMLButtonElement>) => {
    e.preventDefault()
    e.stopPropagation()
    onOpen()
  }
  const label = '横に並べて開く（⌘ + クリック / Ctrl + クリック）'
  return (
    <button type="button" className="iconbtn split-btn" onClick={onClick} title={label} aria-label={label}>
      <SplitMark />
    </button>
  )
}
