import type { AgentActivity } from './api'
import { activitySummary, heldStatusLabel, messageStatusLabel, targetWhyLabel } from './agentActivity.ts'
import { openMessages } from '../../shared/agentWaiting.ts'
import { AgentStopButton } from './AgentStopButton'
import { elapsedLabel } from './format'
import { sessionHash } from './hooks'

const NO_HELD: never[] = []

interface Props {
  /** このセッション（送り元）のエンティティID */
  id: string
  activity: AgentActivity
  /** 経過の基準（ポーリングの updatedAt） */
  now: number
}

/**
 * そのセッションが別のセッションに送ったメッセージのうち、まだ終わっていないもの（#311 / #823）。返答待ち・失敗・預かりの行を並べ、
 * 返答待ちには相手のいまの状態を添え、送り先の名前から相手の画面へ飛べる。往復数と読み直させた量は上限に近いときだけ出す。
 * 「送信を止める」で止められる（「送信を再開する」で戻る）。**出すかどうかは呼び出し側が `agentActivityShown()` で決める**
 * （返答待ち・預かり・失敗が無く、止めてもいなければ出さない）
 */
export function AgentActivityBar({ id, activity, now }: Props) {
  const held = activity.held ?? NO_HELD
  const open = openMessages(activity.recent)
  const summary = activitySummary(activity)
  return (
    <div className={`agent-activity${activity.stopped ? ' stopped' : ''}`}>
      <div className="head">
        <span className="title">別のセッションへのメッセージ</span>
        {summary && <span className="summary">{summary}</span>}
        <AgentStopButton id={id} stopped={activity.stopped} />
      </div>
      {activity.stopped && <div className="note">止めています。このセッションからは別のセッションへ送れません</div>}
      {/* 1 ターンの回数を超えて預かっている送信（#727）。ターンが終わってから SAI が順に送る。「送信を止める」で全部捨てる */}
      {held.length > 0 && (
        <ul className="recent held">
          {held.map((h, n) => (
            <li key={h.message_id} className={h.halted ? 'failed' : 'pending'} title={h.halted ?? 'このセッションのターンが終わってから、上から順に送ります'}>
              <a className="to" href={sessionHash(h.to)} title={`${h.to} の画面を開く`}>
                → {h.to_name}
              </a>
              {/* 何番目に送るかは、止まっているものを除いて数える */}
              <span className="status">{heldStatusLabel(h, held.slice(0, n).filter((x) => !x.halted).length)}</span>
              <span className="time">{elapsedLabel(h.at, now)}</span>
            </li>
          ))}
        </ul>
      )}
      {/* 返答ありの行は出さない（返答は届いた時点で、このセッションの会話に渡っている） */}
      {open.length > 0 && (
        <ul className="recent">
          {open.map((m) => {
            const why = targetWhyLabel(m)
            return (
              <li key={m.message_id} className={m.status}>
                <a className="to" href={sessionHash(m.to)} title={`${m.to} の画面を開く`}>
                  → {m.to_name}
                </a>
                <span className="status">{messageStatusLabel(m.status)}</span>
                {why && <span className="why" title="相手のいまの状態（sai_sessions の「空きでない理由」と同じ語）">相手: {why}</span>}
                <span className="time">{elapsedLabel(m.since, now)}</span>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
