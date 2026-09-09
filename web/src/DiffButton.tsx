import type { SessionDiffSummaryResponse } from './api'
import { DiffMark } from './DiffMark'
import { diffTitle, shortCount } from './diffCount'

export interface DiffButtonProps {
  /** 行数と PR 番号（`useDiffSummary`）。まだ取れていなければ null */
  summary: SessionDiffSummaryResponse | null
  /** いま差分を出しているか。押すと閉じる */
  open: boolean
  onToggle: () => void
}

/**
 * 入力欄の、モデルの左に出す差分のボタン（#211）。中身（patch）を取りに行くのは押したときで、
 * ここに出す行数と PR 番号だけを軽い口（`?summary=1`）から先に取ってある。
 * 押すとトグル（出し方 — 広い画面は右のペイン、狭い画面はモーダル — は App が幅で決める）
 */
export function DiffButton({ summary, open, onToggle }: DiffButtonProps) {
  return (
    <button type="button" className={`diff-btn${open ? ' on' : ''}`} onClick={onToggle} aria-pressed={open} title={diffTitle(summary, open)}>
      <DiffMark />
      {summary && (
        <>
          <span className="add">+{shortCount(summary.added)}</span>
          <span className="del">-{shortCount(summary.removed)}</span>
          {summary.pr && <span className="pr">#{summary.pr.number}</span>}
        </>
      )}
    </button>
  )
}
