import type { DiffComment } from './diffComments'

/** 行の下に出す、残したコメント（#511）。行の中身が書いたときと変わっていれば知らせる（送るのは止めない） */
export function DiffCommentNote({ comment, moved, onRemove }: { comment: DiffComment; moved: boolean; onRemove: () => void }) {
  return (
    <div className="diff-comment">
      <div className="body">{comment.body}</div>
      {moved && <div className="moved">書いたあとに行が変わりました（送る本文には書いたときの行を引用します）</div>}
      <button type="button" className="linkish" onClick={onRemove}>消す</button>
    </div>
  )
}
