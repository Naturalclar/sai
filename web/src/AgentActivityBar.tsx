import { useState } from 'react'
import { api, type AgentActivity } from './api'
import { activitySummary, messageStatusLabel } from './agentActivity.ts'
import { elapsedLabel } from './format'

interface Props {
  /** このセッション（送り元）のエンティティID */
  id: string
  activity: AgentActivity
  /** 経過の基準（ポーリングの updatedAt） */
  now: number
}

/**
 * そのセッションが別のセッションに送ったメッセージのようす（#311）。このターンの往復数・読み直させた量・直近の送り先と状態を出し、
 * 「送信を止める」で止められる（「再開する」で戻る）。止めると、このセッションから送られて預かりに並んでいた分も取り消す
 * （相手でもう回っているターンは止めない）。送ったことが無く止めてもいなければ出さない（サーバが `agent` を載せない）
 */
export function AgentActivityBar({ id, activity, now }: Props) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const toggle = async () => {
    setBusy(true)
    setError('')
    try {
      await (activity.stopped ? api.resumeAgent(id) : api.stopAgent(id))
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className={`agent-activity${activity.stopped ? ' stopped' : ''}`}>
      <div className="head">
        <span className="title">別のセッションへのメッセージ</span>
        <span className="summary">{activitySummary(activity)}</span>
        <button
          type="button"
          disabled={busy}
          onClick={() => void toggle()}
          title={
            activity.stopped
              ? 'このセッションから別のセッションへ、また送れるようにする'
              : 'このセッションから別のセッションへ送るのを止める。預かりに並んでいる分も取り消す（相手でもう回っているターンは止まらない）'
          }
        >
          {activity.stopped ? '再開する' : '送信を止める'}
        </button>
      </div>
      {activity.stopped && <div className="note">止めています。このセッションからは別のセッションへ送れません</div>}
      {activity.recent.length > 0 && (
        <ul className="recent">
          {activity.recent.map((m) => (
            <li key={m.message_id} className={m.status}>
              <span className="to" title={m.to}>
                → {m.to_name}
              </span>
              <span className="status">{messageStatusLabel(m.status)}</span>
              <span className="time">{elapsedLabel(m.since, now)}</span>
            </li>
          ))}
        </ul>
      )}
      {error && <div className="err">{error}</div>}
    </div>
  )
}
