import { useEffect, useState } from 'react'
import { replyBlockedReason } from '../../shared/reply.ts'
import { api } from './api'
import { usePolling } from './hooks'
import { dayLabel, hm } from './format'
import { AgentChip, SynthTag } from './AgentChip'
import { Chat, PendingBubble } from './Chat'
import { ReplyBox } from './ReplyBox'
import { BackLink } from './BackLink'
import type { PaneProps } from './App'

/** 送信した返信。どのエンティティに、そのとき何行あったか */
interface Sent {
  id: string
  text: string
  rowsAtSend: number
}

export function SessionView({ id, onStatus, onOpenSidebar }: { id: string } & PaneProps) {
  const { data, error, updatedAt } = usePolling(() => api.session(id), [id])
  useEffect(() => onStatus(updatedAt, error), [updatedAt, error, onStatus])

  const [sent, setSent] = useState<Sent | null>(null)
  const [sendError, setSendError] = useState<{ id: string; message: string } | null>(null)
  // 「送信中」は state を消すのではなく描画時に決める。返信の結果は既存のフックが JSONL に足す
  // 1行として届くので、行数が送信時より増えたら消える。rev ではなく行数で見るのは、同じ日の
  // ファイルに別セッションの行が増えても rev は変わるため
  const pending = sent && sent.id === id && (data?.rows.length ?? 0) <= sent.rowsAtSend ? sent : null
  const failed = sendError && sendError.id === id ? sendError.message : null

  const send = async (text: string) => {
    setSendError(null)
    setSent({ id, text, rowsAtSend: data?.rows.length ?? 0 })
    try {
      await api.reply(id, text)
    } catch (err) {
      setSent(null)
      setSendError({ id, message: err instanceof Error ? err.message : String(err) })
    }
  }

  const s = data?.session
  const blocked = s ? replyBlockedReason(s) : ''
  return (
    <section>
      <BackLink onOpenSidebar={onOpenSidebar} />
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
      {data && <Chat rows={data.rows} showChannel={false} trailer={pending && <PendingBubble text={pending.text} />} />}
      {s && (blocked ? <div className="notice">{blocked}</div> : <ReplyBox repo={s.repo} busy={pending !== null} onSend={send} />)}
      {failed && <div className="notice error">送信失敗: {failed}</div>}
    </section>
  )
}
