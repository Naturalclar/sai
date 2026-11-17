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
  /** 中に枠（iframe）を持つペインか（#897。PR の解説）。枠の中を押したことを親の窓の blur で拾う */
  hasFrame?: boolean
  /** ペインの中のクリックを先に見る（要対応のペインが、セッションへ飛ぶリンクを隣のペインに開くのに使う） */
  onClickCapture?: ((e: MouseEvent<HTMLDivElement>) => void) | undefined
  children: ReactNode
}

/** フォーカスがこのページの枠の中にある間、枠から別のペインの枠へ移ったかを見る間隔（#897。別のアプリにいる間は何もしない） */
const FRAME_POLL_MS = 300

/**
 * チャットの領域の 1 枚（#633）。並べていないときは今までの `.pane` と同じ箱で、並べているときだけ
 * フォーカスの受け口と × が付く。× は見出しの中でなくここに置く（読み込み中・取得に失敗したペインも閉じられるように）
 */
export function ChatPane({ focused, onFocusPane, onClose, onClickCapture, hasFrame = false, children }: Props) {
  // × を押したときはフォーカスを移さない（閉じるペインへ URL を動かしてから閉じる、の 2 段にしない）
  const onEnter = (e: SyntheticEvent<HTMLDivElement>) => {
    if (focused || !onFocusPane) return
    if (e.target instanceof Element && e.target.closest('.pane-close')) return
    onFocusPane()
  }
  // 枠（解説のペインの iframe。#897）の中を押したとき。枠の中のイベントは親に届かないので、親の document の
  // `activeElement` が**このペインの中の枠に変わった**ことを見る（判定は paneFrameFocus.ts）:
  // - 親の窓の blur のあと（親 → 枠）。blur の時点では activeElement がまだ動いていないことがあるので、次の番で見る
  // - 窓の blur から、窓にフォーカスが戻る（またはフォーカスが枠の外に出たのを見る）までは短い間隔で。枠 → 別のペインの枠と、
  //   別のアプリから枠を直接押して戻ったときは、親の窓に blur も focus も来ないので。activeElement が枠に移るのが遅れても、次の間隔で拾う。
  //   別のアプリにいる間は張ったまま何もしない（`hasFocus()` を 1 回見るだけ）
  // フォーカスを失ったとき自分の枠がまだフォーカスを持っていれば、枠から外す（外さないと、同じ枠をもう一度押しても何も変わらず拾えない）。
  // App は onFocusPane を描くたびに作り直すので、最新を ref に持ち、listener は張り直さない（3 秒のポーリングの描き直しで確かめを取り消さない）
  const ref = useRef<HTMLDivElement>(null)
  const focusNow = useRef(onFocusPane)
  useEffect(() => {
    focusNow.current = onFocusPane
  }, [onFocusPane])
  const watch = hasFrame && !focused && !!onFocusPane
  useEffect(() => {
    if (!watch) return
    let last = document.activeElement
    if (last instanceof HTMLElement && frameFocusedIn<Element>(last, ref.current)) {
      last.blur()
      last = document.activeElement
    }
    let poll: ReturnType<typeof setInterval> | undefined
    const stopPoll = () => {
      clearInterval(poll)
      poll = undefined
    }
    const check = () => {
      const now = document.activeElement
      if (now === last) return
      last = now
      if (frameFocusedIn<Element>(now, ref.current)) focusNow.current?.()
    }
    let timer: ReturnType<typeof setTimeout> | undefined
    // 時間では止めない（長く読んだあとに枠から別の枠へ移ったのを拾えなくなる。止めたら張り直す手がかりが無い。#897 の再レビュー）
    const tick = () => {
      if (!document.hasFocus()) return
      check()
      // このページにフォーカスがあって枠の外（親の document）にいるなら、もう見なくてよい（次に枠へ入るときは窓の blur が来る）
      if (document.activeElement?.tagName !== 'IFRAME') stopPoll()
    }
    const startPoll = () => {
      poll ??= setInterval(tick, FRAME_POLL_MS)
    }
    const onBlur = () => {
      clearTimeout(timer)
      timer = setTimeout(check, 0)
      startPoll()
    }
    const onFocus = () => {
      stopPoll()
      last = document.activeElement
    }
    window.addEventListener('blur', onBlur)
    window.addEventListener('focus', onFocus)
    if (!document.hasFocus() || document.activeElement?.tagName === 'IFRAME') startPoll()
    return () => {
      window.removeEventListener('blur', onBlur)
      window.removeEventListener('focus', onFocus)
      clearTimeout(timer)
      stopPoll()
    }
  }, [watch])
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
