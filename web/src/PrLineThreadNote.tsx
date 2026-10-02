import type { PrLineComment } from '../../shared/types.ts'
import type { PrLineThread } from '../../shared/prLineComments.ts'
import { Markdown } from './Markdown'
import { OpenInGitHub } from './OpenInGitHub'
import { commentAuthor } from './prCommentLabels'
import { agoLabel } from './prLabels'

/**
 * GitHub で差分の行に付いた、ひとまとまりのやり取り（#600 の案 2。最初のコメントと返信）。**読むだけ**で、返信・解決の口は無い。
 * 下書きのコメント（`DiffCommentNote`）と同じ場所（行の下）に、**書かれたもの**として色を分けて出す。
 * `onQuote` があれば「返信欄に入れる」を出す（案 3。やり取りごと引用として足すだけで、送らない）。
 * 本文は今の `Markdown`（HTML 文字列は作らない・外の URL の画像は読み込まない）
 */
export function PrLineThreadNote({ thread, now, onQuote }: { thread: PrLineThread; now: number; onQuote?: (thread: PrLineThread) => void }) {
  const one = (c: PrLineComment) => (
    <div className="one" key={c.id}>
      <div className="head">
        <span className="author">{commentAuthor(c.author)}</span>
        {c.bot && <span className="fold">bot</span>}
        <span className="ago" title={c.at}>{agoLabel(c.at, now)}</span>
      </div>
      <div className="body">
        <Markdown text={c.body} />
      </div>
      {c.truncated && <div className="warn">長いので途中までです。</div>}
    </div>
  )
  return (
    <div className="diff-comment posted">
      {one(thread.root)}
      {thread.replies.map(one)}
      {(thread.root.url || onQuote) && (
        <div className="foot">
          {thread.root.url && <OpenInGitHub href={thread.root.url} />}
          {onQuote && (
            <button type="button" className="linkish quote" onClick={() => onQuote(thread)}>
              返信欄に入れる
            </button>
          )}
        </div>
      )}
    </div>
  )
}
