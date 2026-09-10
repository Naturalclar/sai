import { targetProjectLabel, type ReplyTarget } from '../../shared/reply.ts'

/**
 * 入力欄の上の返信先のチップの中身（`→ #repo リポジトリ branch「タイトル」`）。フィードの `ReplyBox` だけが出す。
 * 押せるとき（#297。最後の発言へ飛ぶ）はボタンの中に、押せないときはそのまま並べる
 */
export function TargetLabel({ target }: { target: ReplyTarget }) {
  const project = targetProjectLabel(target)
  return (
    <>
      <span className="arrow">→</span>
      {target.icon && <img className="icon" src={target.icon} alt="" />}
      <b>#{target.repo}</b>
      {/* どのリポジトリへ送るか（#301）。候補で見分けても、選んだあとに見えないと意味が薄い */}
      {project && <span className="project" title={target.project}>{project}</span>}
      {target.branch && <code>{target.branch}</code>}
      {target.title && <span className="title">「{target.title}」</span>}
    </>
  )
}
