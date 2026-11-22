// 自分のセッションの行が、チャットにバブル（か区切り線・待ちの行）を立てるか（#903 のレビュー）。画面の `web/src/chatGroups.ts` の
// `toUtterances()` と同じ線で、サーバが返答のバブルのまとまり（`shared/agentResults.ts` の `sameBubble()`）を見るのに使う。
// 揃っているかは `web/src/chatBubbles.test.ts` が `toUtterances()` と突き合わせる
import { isCompactSummaryText } from './compactSummary.ts'
import { eventKind } from './events.ts'
import type { FeedRow } from './types.ts'

/** 立てないのは、入力待ち（`idle`）・知らない event（`other`）・人の入力の無い入力の行（自動の要約の文だけのものも）。別のセッションからの返答の行は渡さない */
export function rowMakesBubble(row: Pick<FeedRow, 'event' | 'text' | 'user_text'>): boolean {
  const kind = eventKind(row.event, row.text)
  if (kind === 'idle' || kind === 'other') return false
  if (kind === 'resume') return !isCompactSummaryText(row.user_text) && (row.user_text ?? '').trim() !== ''
  return true
}
