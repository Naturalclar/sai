import type { ReactNode, SyntheticEvent } from 'react'
import { CloseMark } from './CloseMark'

interface Props {
  /** フォーカスのあるペインか。入力・`↑↓`・許可の ⌘Enter・題名はここに向く */
  focused: boolean
  /** 並べているときだけ渡す。ペインの中を押した・フォーカスが入ったら、このペインにフォーカスを移す */
  onFocusPane?: (() => void) | undefined
  /** 並べているときだけ渡す。右上に × を出す */
  onClose?: (() => void) | undefined
  children: ReactNode
}

/**
 * チャットの領域の 1 枚（#633）。並べていないときは今までの `.pane` と同じ箱で、並べているときだけ
 * フォーカスの受け口と × が付く。× は見出しの中でなくここに置く（読み込み中・取得に失敗したペインも閉じられるように）
 */
export function ChatPane({ focused, onFocusPane, onClose, children }: Props) {
  // × を押したときはフォーカスを移さない（閉じるペインへ URL を動かしてから閉じる、の 2 段にしない）
  const onEnter = (e: SyntheticEvent<HTMLDivElement>) => {
    if (focused || !onFocusPane) return
    if (e.target instanceof Element && e.target.closest('.pane-close')) return
    onFocusPane()
  }
  return (
    <div className={`pane${focused ? ' focused' : ''}`} onPointerDownCapture={onEnter} onFocusCapture={onEnter}>
      {onClose && (
        <button type="button" className="iconbtn pane-close" onClick={onClose} aria-label="このペインを閉じる" title="このペインを閉じる">
          <CloseMark />
        </button>
      )}
      {children}
    </div>
  )
}
