import type { PrComment } from './api'
import { Markdown } from './Markdown'
import { OpenInGitHub } from './OpenInGitHub'
import { commentAuthor, foldLabel, reviewStateLabel } from './prCommentLabels'
import { agoLabel } from './prLabels'

/**
 * PR のコメント 1 件（#600）。会話のコメントか、レビューの本文と判定。**読むだけ**（返信・解決の口は無い）。
 * 本文は今の `Markdown` で描く（HTML 文字列は作らない・外の URL の画像は読み込まない）。
 * GitHub で畳まれたものと bot のものは 1 行にして、押すと開く（`<details>`。開け閉めの状態は持たない）
 */
export function PrCommentItem({ comment, now }: { comment: PrComment; now: number }) {
  const state = reviewStateLabel(comment.state)
  const fold = foldLabel(comment.folded)
  const head = (
    <>
      <span className="author">{commentAuthor(comment.author)}</span>
      {state && <span className={`tag review-state ${state.tone}`}>{state.label}</span>}
      {fold && <span className="fold">{fold}</span>}
      <span className="ago" title={comment.at}>{agoLabel(comment.at, now)}</span>
    </>
  )
  const body = (
    <>
      {comment.body.trim() && (
        <div className="body">
          <Markdown text={comment.body} />
        </div>
      )}
      {(comment.truncated || comment.url) && (
        <div className="foot">
          {comment.truncated && <span className="warn">長いので途中までです。</span>}
          {comment.url && <OpenInGitHub href={comment.url} />}
        </div>
      )}
    </>
  )
  const cls = `pr-comment ${comment.kind}${state ? ` ${state.tone}` : ''}`
  if (fold) {
    return (
      <details className={`${cls} folded`}>
        <summary className="head">{head}</summary>
        {body}
      </details>
    )
  }
  return (
    <article className={cls}>
      <div className="head">{head}</div>
      {body}
    </article>
  )
}
