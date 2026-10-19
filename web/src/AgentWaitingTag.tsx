import type { AgentWaitCount } from '../../shared/types.ts'
import { agentWaitLabel } from '../../shared/agentWaiting.ts'

/**
 * 「返答待ち N」の印（#823）。このセッションが別のセッションへ送って、返答がまだのもの＋預かりの数。失敗があれば色を変える。
 * サイドバーの行とチャット見出しが同じ数（`agentWaitCount()`）を出す。人の番ではない（相手の番）ので要対応には数えない
 */
export function AgentWaitingTag({ count }: { count: AgentWaitCount }) {
  const notes = [count.waiting > 0 ? `返答待ち・預かり ${count.waiting} 件` : '', count.failed > 0 ? `失敗・止まったもの ${count.failed} 件` : ''].filter(Boolean)
  return (
    <span className={`tag agent-waiting${count.failed > 0 ? ' failed' : ''}`} title={`別のセッションへのメッセージ: ${notes.join('、')}`}>
      {agentWaitLabel(count)}
    </span>
  )
}
