import { useEffect, useRef } from 'react'
import { DiffBody } from './DiffBody'

/** 狭い画面の差分。広い画面は右のペイン（`DiffPane`）で出す */
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
        <div className="title">このセッションの差分</div>
        <DiffBody id={id} />
        <div className="actions">
          <button type="button" onClick={onClose}>閉じる</button>
        </div>
      </div>
    </div>
  )
}
