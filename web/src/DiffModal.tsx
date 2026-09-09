import { useEffect, useRef } from 'react'
import { DiffBody } from './DiffBody'
import { IconButton } from './IconButton'
import { CloseMark } from './CloseMark'

/**
 * 狭い画面の差分。広い画面は右のペイン（`DiffPane`）で出す。
 * 中身（`.diff-scroll`）だけがスクロールし、**閉じるボタンは右上に出たまま**になる（#221。
 * 前はモーダル全体が流れたので、閉じるは差分の一番下にあって最後まで送らないと押せなかった）
 */
export function DiffModal({ id, onClose }: { id: string; onClose: () => void }) {
  const dialogRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    dialogRef.current?.focus()
  }, [])

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div
        className="modal diff"
        role="dialog"
        aria-modal="true"
        aria-label="このセッションの差分"
        tabIndex={-1}
        ref={dialogRef}
        onKeyDown={(e) => e.key === 'Escape' && onClose()}
      >
        <div className="diff-head">
          <div className="title">このセッションの差分</div>
          <IconButton label="差分を閉じる" onClick={onClose}>
            <CloseMark />
          </IconButton>
        </div>
        <div className="diff-scroll">
          <DiffBody id={id} />
        </div>
      </div>
    </div>
  )
}
