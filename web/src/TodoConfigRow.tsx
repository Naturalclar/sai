import { projectName } from '../../shared/project.ts'
import { withSuffix } from '../../shared/sessionLabels.ts'
import type { TodoItem } from '../../shared/todoItems.ts'
import { AgentChip } from './AgentChip'
import type { CodexConfigHold } from './api'
import { elapsedLabel } from './format'
import { useCodexConfigAction } from './useCodexConfigAction'

interface Props {
  item: TodoItem
  /** 何を確かめるか（`item.config`。呼ぶ側が有るものだけ渡す） */
  hold: CodexConfigHold
  /** いまの時刻（一覧を取った時刻）。「止めてから N 分」の基準 */
  now: number
}

/**
 * 「要対応」の、Codex を起こす前の確かめの 1 行（#856）。**押すまで起こさない**。出すのはファイルの名前までで、中身は出さない
 * （人が端末やエディタで見る）。「このまま起こす」を押すと中身が変わるまで覚え、預かっている返信があれば回す
 */
export function TodoConfigRow({ item, hold, now }: Props) {
  const s = item.session
  const label = s ? withSuffix(s.meta?.name || s.title || s.id, s) : item.id
  const where = s ? projectName(s.project) || s.repo : ''
  const since = elapsedLabel(item.since, now)
  const { busy, error, allow, dismiss } = useCodexConfigAction(item.id, hold.fingerprint)
  return (
    <div className="todo config">
      <div className="who-row">
        <a className="who" href={`#/s/${encodeURIComponent(item.id)}`} title={item.id}>
          {s?.icon && <img className="icon" src={s.icon} alt="" />}
          <span className="name">{label}</span>
          {where && <span className="where">#{where}</span>}
          {s && <AgentChip agent={s.agent || 'unknown'} />}
          {since && <span className="waited">止めてから {since}</span>}
        </a>
      </div>
      <div className="why-row">
        <div className="why">
          <span className="tag wait-done" title={hold.cwd}>
            起こす前の確かめ
          </span>
          <span className="text">{item.text}</span>
          {hold.files.length > 0 && (
            <ul className="config-files">
              {hold.files.map((path) => (
                <li key={path}>{path}</li>
              ))}
              {hold.more > 0 && <li>ほか {hold.more} 件</li>}
            </ul>
          )}
        </div>
        <span className="wait-actions">
          <button type="button" className="primary" disabled={busy} onClick={allow} title="中身を確かめたので、Codex を起こす（中身が変わるまで覚える。確かめられないものは今回だけ）">
            このまま起こす
          </button>
          <button type="button" disabled={busy} onClick={dismiss} title="この行を片付ける（起こさない。預かった返信は止まったまま）">
            片付ける
          </button>
        </span>
      </div>
      {error && <div className="notice error reply-failed">{error}</div>}
    </div>
  )
}
