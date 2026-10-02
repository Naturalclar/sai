import { draftSummary } from './prHeadLabels'

/**
 * PR の画面の差分の上に残す、下書きの案内と「全部消す」（#646）。入れる・投稿するボタンは題名の行（`PrHeadActions`）に移した。
 * **消す操作は、いつも見えている行には置かない**（読みながら押し間違えると下書きが全部消える）
 */
export function PrDraftBar({ count, hasBody, onClear }: { count: number; hasBody: boolean; onClear: () => void }) {
  const summary = draftSummary(count, hasBody)
  if (!summary) return <div className="diff-comment-bar hint">行番号を押すと、その行にコメントを書けます</div>
  return (
    <div className="diff-comment-bar">
      <span className="n">{summary}</span>
      <button type="button" className="linkish" onClick={onClear}>全部消す</button>
    </div>
  )
}
