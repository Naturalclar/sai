import type { AgentRequest } from '../../shared/types.ts'
import { prHash } from '../../shared/prs.ts'
import { requestItemLabel, requestSummary, resultLabel } from './agentRequests.ts'
import { sessionHash } from './hooks'
import { ResultCheckButton } from './ResultCheckButton'

interface Props {
  /** このセッション（送り元）のエンティティID。返答の飛び先はこの画面の返答のバブル */
  id: string
  request: AgentRequest
}

/**
 * 1 つの依頼（送り元の 1 ターン）で振った先と、その進み具合（#902）。見出しに件数、開くと相手ごとの状態・相手の画面・返答のバブルへの飛び先。
 * 送る・頼み直す・止めるはここに置かない。`返答あり` は返答の行が来たというだけで、成果を確かめたという意味ではない。
 * 確かめる成果を返したもの（`item.result`。#903）だけ、成果の状態・確かめる先（返答のバブル・PR）・「確認済みにする」を出す。
 * 直してほしければ、返答のバブルの下の返信欄から頼む（#700。ここに別の入力欄は置かない）
 */
export function RequestProgressCard({ id, request }: Props) {
  const summary = requestSummary(request)
  const waiting = request.items.some((i) => i.result && !i.result.checked_at)
  return (
    <details className={`agent-activity request-progress${waiting ? ' unchecked' : ''}`}>
      <summary>
        <span className="title">依頼の進捗</span> <span className="summary">{summary}</span>
      </summary>
      <ul className="recent">
        {request.items.map((item) => (
          <li key={item.message_id} className={item.status} {...(item.halted ? { title: item.halted } : {})}>
            <span className="line">
              <a className="to" href={sessionHash(item.to)} title={`${item.to} の画面を開く`}>
                → {item.to_name}
              </a>
              <span className="status">{requestItemLabel(item)}</span>
              {item.reply_ts && !item.result && (
                <a className="reply-link" href={sessionHash(id, item.reply_ts, 'agent')} title="この画面の返答のバブルへ">
                  返答へ
                </a>
              )}
            </span>
            {item.result && (
              <span className={`result${item.result.checked_at ? ' checked' : ''}`}>
                <span className="result-state">{resultLabel(item.result)}</span>
                <a className="reply-link" href={sessionHash(id, item.result.ts, 'agent')} title="この画面の返答のバブルへ（直してほしければ、バブルの下の返信欄から頼む）">
                  返答へ
                </a>
                {(item.result.prs ?? []).map((p) => (
                  <a key={`pr:${p.repo}#${p.number}`} className="reply-link" href={prHash(p.repo, p.number)} title={`${p.repo} の PR #${p.number} を SAI の PR 画面で開く`}>
                    PR #{p.number}
                  </a>
                ))}
                <ResultCheckButton id={id} to={item.to} result={item.result} />
              </span>
            )}
          </li>
        ))}
      </ul>
    </details>
  )
}
