import type { AgentRequest } from '../../shared/types.ts'
import { requestItemLabel, requestSummary } from './agentRequests.ts'
import { sessionHash } from './hooks'

interface Props {
  /** このセッション（送り元）のエンティティID。返答の飛び先はこの画面の返答のバブル */
  id: string
  request: AgentRequest
}

/**
 * 1 つの依頼（送り元の 1 ターン）で振った先と、その進み具合（#902）。見出しに件数、開くと相手ごとの状態・相手の画面・返答のバブルへの飛び先。
 * **読むだけ**（送る・頼み直す・止めるはここに置かない）。`返答あり` は返答の行が来たというだけで、成果を確かめたという意味ではない
 */
export function RequestProgressCard({ id, request }: Props) {
  return (
    <details className="agent-activity request-progress">
      <summary>
        <span className="title">依頼の進捗</span> <span className="summary">{requestSummary(request)}</span>
      </summary>
      <ul className="recent">
        {request.items.map((item) => (
          <li key={item.message_id} className={item.status} {...(item.halted ? { title: item.halted } : {})}>
            <a className="to" href={sessionHash(item.to)} title={`${item.to} の画面を開く`}>
              → {item.to_name}
            </a>
            <span className="status">{requestItemLabel(item)}</span>
            {item.reply_ts && (
              <a className="reply-link" href={sessionHash(id, item.reply_ts, 'agent')} title="この画面の返答のバブルへ">
                返答へ
              </a>
            )}
          </li>
        ))}
      </ul>
    </details>
  )
}
