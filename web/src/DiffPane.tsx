import { DiffBody } from './DiffBody'
import { IconButton } from './IconButton'
import { CloseMark } from './CloseMark'

/**
 * 広い画面の差分。チャットの右にもう1枚のペインとして出す（`main.layout.diff-open` の3列目）。
 * チャットを見ながら差分を読めるので、モーダルのように会話を隠さない。狭い画面は `DiffModal`
 */
export function DiffPane({ id, onClose }: { id: string; onClose: () => void }) {
  return (
    <aside className="diff-pane" aria-label="このセッションの差分">
      <div className="diff-head">
        <div className="title">差分</div>
        <IconButton label="差分を閉じる" onClick={onClose}>
          <CloseMark />
        </IconButton>
      </div>
      <div className="diff-scroll">
        <DiffBody id={id} />
      </div>
    </aside>
  )
}
