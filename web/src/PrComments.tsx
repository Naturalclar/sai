import type { PrDetailResponse } from './api'
import { PrCommentItem } from './PrCommentItem'
import { commentsHeading } from './prCommentLabels'

/**
 * PR に付いている会話のコメントとレビュー（#600）。本文の下・差分の上に、時刻の古い順で並べる。
 * 取るのは PR を開いたときと「更新」のときだけ（`PrView` の 1 回の応答に載ってくる）。
 * 読めなかったときは 1 行出すだけで、本文と差分はそのまま出る。1 件も無ければ何も出さない
 */
export function PrComments({ data, now }: { data: PrDetailResponse; now: number }) {
  if (data.comments_error) return <div className="warn pr-comments-error">{data.comments_error}</div>
  const list = data.comments ?? []
  if (list.length === 0) return null
  return (
    <section className="pr-comments">
      <h2>{commentsHeading(list.length, data.comments_omitted)}</h2>
      {list.map((c) => (
        <PrCommentItem key={c.id} comment={c} now={now} />
      ))}
    </section>
  )
}
