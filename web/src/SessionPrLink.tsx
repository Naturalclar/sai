import type { PrSummary } from '../../shared/types.ts'
import { prHash } from '../../shared/prs.ts'
import { SessionPrBadge } from './SessionPrBadge'
import { sessionPrTag } from './sessionPrState.ts'

/**
 * そのセッションの PR へのリンク（#554。要対応の行とフィードの見出し）。見た目と色はサイドバーの印（`SessionPrTag`）と同じで、
 * こちらは押すと SAI の PR 画面（`#/pr/<owner>/<repo>/<番号>`。差分も読める）を開く。GitHub へはその画面から。
 * **リンクの中には置かない**（置く側がセッションへのリンクの外に並べる）
 */
export function SessionPrLink({ repo, pr }: { repo: string; pr: PrSummary }) {
  const tag = sessionPrTag(pr)
  return (
    <a className={`tag session-pr ${tag.state}`} href={prHash(repo, pr.number)} title={tag.title}>
      <SessionPrBadge pr={pr} tag={tag} />
    </a>
  )
}
