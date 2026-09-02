import { useEffect } from 'react'
import { api } from './api'
import { usePolling } from './hooks'
import { dayLabel, hm } from './format'
import { AgentChip, SynthTag } from './AgentChip'
import { Chat } from './Chat'
import type { StatusProps } from './App'

export function SessionView({ id, onStatus }: { id: string } & StatusProps) {
  const { data, error, updatedAt } = usePolling(() => api.session(id), [id])
  useEffect(() => onStatus(updatedAt, error), [updatedAt, error, onStatus])

  const s = data?.session
  return (
    <section>
      <a className="back" href="#/">← セッション一覧</a>
      {s && (
        <div className="chat-head">
          <h1><span className="hash">#</span>{s.repo}</h1>
          <span className="meta"><AgentChip agent={s.agent} /></span>
          {s.branch && <span className="meta"><code>{s.branch}</code></span>}
          <span className="meta">{dayLabel(s.start)} {hm(s.start)} – {hm(s.end)} · {s.turns} ターン</span>
          <span className="meta" title={s.id}>
            {s.session_source === 'synth' ? <SynthTag /> : <span className="tag">{s.session_source}</span>}
          </span>
          {s.title_full && <div className="meta wide">{s.title_full}</div>}
        </div>
      )}
      {error && !data && <div className="empty">{error}</div>}
      {data && <Chat rows={data.rows} showChannel={false} />}
    </section>
  )
}
