import type { ReplyTarget } from '../../shared/reply.ts'

/**
 * 入力欄の上の返信先のチップの中身（`→ #repo branch「タイトル」`）。フィードの `ReplyBox` だけが出す。
 * 押せるとき（#297。最後の発言へ飛ぶ）はボタンの中に、押せないときはそのまま並べる
 */
export function TargetLabel({ target }: { target: ReplyTarget }) {
  return (
    <>
      <span className="arrow">→</span>
      {target.icon && <img className="icon" src={target.icon} alt="" />}
      <b>#{target.repo}</b>
      {target.branch && <code>{target.branch}</code>}
      {target.title && <span className="title">「{target.title}」</span>}
    </>
  )
}
