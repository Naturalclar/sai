// 送ったメッセージへの返答（#588）を、セッション画面のチャットの行に混ぜる。DOM に依存しないので agentReplies.test.ts で回す
import type { FeedRow } from '../../shared/types.ts'

/**
 * このセッションの行と、別のセッションから届いた返答の行を時刻の順に並べる。同じ時刻ならこのセッションの行を先に
 * （返答は送った文より後に来るので、並びが入れ替わらないように）。返答が無ければ元の配列をそのまま返す（描き直しを増やさない）
 */
export function withAgentReplies(rows: FeedRow[], replies: readonly FeedRow[] | undefined): FeedRow[] {
  if (!replies || replies.length === 0) return rows
  const at = (r: FeedRow) => Date.parse(r.ts)
  return [...rows, ...replies].map((r, i) => ({ r, i })).sort((a, b) => at(a.r) - at(b.r) || a.i - b.i).map(({ r }) => r)
}
