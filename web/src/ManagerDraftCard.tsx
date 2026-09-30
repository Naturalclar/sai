import { useState } from 'react'
import { managerDraftFolds } from './managerDraftFold'

interface Props {
  text: string
  /** 入力欄に入れる（`→` と同じ。送らない） */
  onAccept: () => void
  /** 捨てる */
  onDiscard: () => void
}

/**
 * Manager が置いた案（#565。`sai_suggest`）の札。入力欄のすぐ上に出し、**出どころ（Manager からの案）と全文**を見せる。
 * ゴースト（入力欄の背面）は入力欄の高さで切れるので、全文はここで読む。長ければ畳んで「全部見る」で開く。
 * 「入れる」は入力欄に入れるだけで送らない。どちらのボタンも入力欄のフォーカスは奪わない（SuggestionChip と同じ）
 */
export function ManagerDraftCard({ text, onAccept, onDiscard }: Props) {
  const folds = managerDraftFolds(text)
  const [open, setOpen] = useState(false)
  return (
    <div className="manager-draft" role="group" aria-label="Manager からの案">
      <div className="head">
        <span className="from">Manager からの案</span>
        <span className="hint">→ で入力欄に入れる（送りはしない）</span>
      </div>
      <div className={`body${folds && !open ? ' folded' : ''}`}>{text}</div>
      <div className="actions">
        {folds && (
          <button type="button" className="fold" onMouseDown={(e) => e.preventDefault()} onClick={() => setOpen(!open)} aria-expanded={open}>
            {open ? '畳む' : '全部見る'}
          </button>
        )}
        <button type="button" className="accept" onMouseDown={(e) => e.preventDefault()} onClick={onAccept}>
          入れる
        </button>
        <button type="button" className="discard" onMouseDown={(e) => e.preventDefault()} onClick={onDiscard}>
          捨てる
        </button>
      </div>
    </div>
  )
}
