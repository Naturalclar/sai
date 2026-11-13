import { useState } from 'react'
import { projectName } from '../../shared/project.ts'
import { withSuffix } from '../../shared/sessionLabels.ts'
import { START_AGENT_LABEL } from '../../shared/startDraft.ts'
import type { StartDraft } from '../../shared/types.ts'
import type { TodoItem } from '../../shared/todoItems.ts'
import { AgentChip } from './AgentChip'
import { api } from './api'
import { elapsedLabel } from './format'
import { START_DRAFT_PICK_KEY } from './newSession'

interface Props {
  item: TodoItem
  /** 置かれた案（`item.start`。呼ぶ側が有るものだけ渡す） */
  draft: StartDraft
  /** いまの時刻（一覧を取った時刻）。「置いてから N 分」の基準 */
  now: number
}

/**
 * 「要対応」の、新しい worktree と新しいセッションの案の 1 行（#892。`sai_start`）。**押すまで何も作らない・起こさない**。
 * 「開く」は「新しいセッション」のペインを中身入りで開くだけで、始めるのはそこで人が押したとき
 */
export function TodoStartRow({ item, draft, now }: Props) {
  const s = item.session
  const label = s ? withSuffix(s.meta?.name || s.title || s.id, s) : item.id
  const where = s ? projectName(s.project) || s.repo : ''
  const since = elapsedLabel(item.since, now)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const discard = async () => {
    setBusy(true)
    setError('')
    try {
      await api.startDraftAction(item.id, { at: draft.at })
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="todo start-draft">
      <div className="who-row">
        <a className="who" href={`#/s/${encodeURIComponent(item.id)}`} title={item.id}>
          {s?.icon && <img className="icon" src={s.icon} alt="" />}
          <span className="name">{label}</span>
          {where && <span className="where">#{where}</span>}
          {s && <AgentChip agent={s.agent || 'unknown'} />}
          {since && <span className="waited">置いてから {since}</span>}
        </a>
      </div>
      <div className="why-row">
        <div className="why">
          <span className="tag wait-done">新しいセッションの案</span>
          <span className="text">
            worktree「{draft.name}」で {START_AGENT_LABEL[draft.agent]} を始める
          </span>
          <div className="start-draft-text">{draft.text}</div>
        </div>
        <span className="wait-actions">
          <a className="open-new" href="#/new" onClick={() => sessionStorage.setItem(START_DRAFT_PICK_KEY, item.id)} title="「新しいセッション」を中身入りで開く（そこで押すまで何も作らない）">
            開く
          </a>
          <button type="button" disabled={busy} onClick={() => void discard()} title="この案を捨てる（何も作らない）">
            捨てる
          </button>
        </span>
      </div>
      {error && <div className="notice error reply-failed">{error}</div>}
    </div>
  )
}
