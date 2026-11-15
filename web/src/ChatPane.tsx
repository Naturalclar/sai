import { useEffect, useRef, type MouseEvent, type ReactNode, type SyntheticEvent } from 'react'
import { CloseMark } from './CloseMark'
import { frameFocusedIn } from './paneFrameFocus'

interface Props {
  /** フォーカスのあるペインか。入力・`↑↓`・許可の ⌘Enter・題名はここに向く */
  focused: boolean
  /** 並べているときだけ渡す。ペインの中を押した・フォーカスが入ったら、このペインにフォーカスを移す */
  onFocusPane?: (() => void) | undefined
  /** 並べているときだけ渡す。右上に × を出す */
  onClose?: (() => void) | undefined
  /** ペインの中のクリックを先に見る（要対応のペインが、セッションへ飛ぶリンクを隣のペインに開くのに使う） */
  onClickCapture?: ((e: MouseEvent<HTMLDivElement>) => void) | undefined
  children: ReactNode
}

/**
 * チャットの領域の 1 枚（#633）。並べていないときは今までの `.pane` と同じ箱で、並べているときだけ
 * フォーカスの受け口と × が付く。× は見出しの中でなくここに置く（読み込み中・取得に失敗したペインも閉じられるように）
 */
export function ChatPane({ focused, onFocusPane, onClose, onClickCapture, children }: Props) {
  // × を押したときはフォーカスを移さない（閉じるペインへ URL を動かしてから閉じる、の 2 段にしない）
  const onEnter = (e: SyntheticEvent<HTMLDivElement>) => {
    if (focused || !onFocusPane) return
    if (e.target instanceof Element && e.target.closest('.pane-close')) return
    onFocusPane()
  }
  // 枠（解説のペインの iframe。#897）の中を押したとき。枠の中のイベントは親に届かないので、親の窓の blur のあとに
  // フォーカスがこのペインの枠に入ったかを見る（判定は paneFrameFocus.ts）。blur の時点では activeElement がまだ動いていないことがあるので、次の番で見る
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (focused || !onFocusPane) return
    let timer: ReturnType<typeof setTimeout> | undefined
    const onBlur = () => {
      clearTimeout(timer)
      timer = setTimeout(() => {
        if (frameFocusedIn<Element>(document.activeElement, ref.current)) onFocusPane()
      }, 0)
    }
    window.addEventListener('blur', onBlur)
    return () => {
      window.removeEventListener('blur', onBlur)
      clearTimeout(timer)
    }
  }, [focused, onFocusPane])
  return (
    <div ref={ref} className={`pane${focused ? ' focused' : ''}`} onPointerDownCapture={onEnter} onFocusCapture={onEnter} onClickCapture={onClickCapture}>
      {onClose && (
        <button type="button" className="iconbtn pane-close" onClick={onClose} aria-label="このペインを閉じる" title="このペインを閉じる">
          <CloseMark />
        </button>
      )}
      {children}
    </div>
  )
}
