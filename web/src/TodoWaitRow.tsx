import { projectName } from '../../shared/project.ts'
import type { TodoItem } from '../../shared/todoItems.ts'
import type { Wait } from './api'
import { AgentChip } from './AgentChip'
import { elapsedLabel } from './format'
import { useWaitAction } from './useWaitAction'
import { withSuffix } from '../../shared/sessionLabels.ts'

interface Props {
  item: TodoItem
  /** その行の待ち（`item.wait`。呼ぶ側が有るものだけ渡す） */
  wait: Wait
  /** いまの時刻（一覧を取った時刻）。「終わってから N 分」の基準 */
  now: number
}

/**
 * 「要対応」の、終わったのに自動では起こさない待ちの 1 行（#732）。待ち始めてから長く経って終わった待ちは、キャッシュが切れていて
 * 起こすと高くつくので SAI は起こさない。**人が「いま起こす」か「片付ける」を押すまで何も起きない**ので、ここに出す。
 * 叩く口はそのセッションの帯（`WaitBar`）と同じで、起こせた・片付けた待ちは次のポーリングで行ごと消える
 */
export function TodoWaitRow({ item, wait, now }: Props) {
  const s = item.session
  const label = s ? withSuffix(s.meta?.name || s.title || s.id, s) : item.id
  const where = s ? projectName(s.project) || s.repo : ''
  const since = elapsedLabel(item.since, now)
  const { busy, error, wake, stop } = useWaitAction(item.id, wait.id)
  return (
    <div className="todo wait">
      <div className="who-row">
        <a className="who" href={`#/s/${encodeURIComponent(item.id)}`} title={item.id}>
          {s?.icon && <img className="icon" src={s.icon} alt="" />}
          <span className="name">{label}</span>
          {where && <span className="where">#{where}</span>}
          {s && <AgentChip agent={s.agent || 'unknown'} />}
          {since && <span className="waited">終わってから {since}</span>}
        </a>
      </div>
      <div className="why-row">
        <div className="why">
          <span className="tag wait-done" title={wait.reason ?? ''}>
            CI 終了
          </span>
          <span className="text">{item.text}</span>
          <span className="sub">起きたら: {wait.then}</span>
        </div>
        <span className="wait-actions">
          <button type="button" className="primary" disabled={busy} onClick={wake} title="結果を渡して、いまこのセッションを起こす（キャッシュが切れているので、文脈を読み直す。大きければ要約してから）">
            いま起こす
          </button>
          <button type="button" disabled={busy} onClick={stop} title="この待ちをやめる（起こさない）">
            片付ける
          </button>
        </span>
      </div>
      {error && <div className="notice error reply-failed">{error}</div>}
    </div>
  )
}
