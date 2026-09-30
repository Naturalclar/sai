import type { PrSummary } from '../../shared/types.ts'
import { GitHubMark } from './GitHubMark'
import { sessionPrTag } from './sessionPrState.ts'

/**
 * サイドバーの項目に付ける、そのセッションの PR の印（#548。`GitHub の印 + #番号`）。
 * 項目そのものがセッションへのリンクなので、この印はリンクにしない（`<a>` の中に `<a>` は置けない）。
 * 開いたセッションの差分ボタンの横に PR へのリンク（#536）がある。状態は色で分け、言葉は title に出す
 */
export function SessionPrTag({ pr }: { pr: PrSummary }) {
  const tag = sessionPrTag(pr)
  return (
    <span className={`tag session-pr ${tag.state}`} title={tag.title}>
      <GitHubMark size={10} />#{pr.number}
    </span>
  )
}
