import { useEffect } from 'react'
import { replyBlockedReason } from '../../shared/reply.ts'
import { eventKind } from '../../shared/events.ts'
import { promptArrived } from './chatGroups'
import { api } from './api'
import { usePolling } from './hooks'
import { dayLabel, hm } from './format'
import { AgentChip } from './AgentChip'
import { SynthTag } from './SynthTag'
import { ReplyingTag } from './ReplyingTag'
import { WaitingTag } from './WaitingTag'
import { Chat } from './Chat'
import { PendingBubble } from './PendingBubble'
import { ReplyBox } from './ReplyBox'
import { BackLink } from './BackLink'
import { useReply } from './useReply'
import { MetaEditor } from './MetaEditor'
import { ArchiveButton } from './ArchiveButton'
import { ArchivedTag } from './ArchivedTag'
import type { PaneProps } from './App'

const NO_REPLYING = {}

export function SessionView({ id, onStatus, onOpenSidebar }: { id: string } & PaneProps) {
  const { data, error, updatedAt } = usePolling(() => api.session(id), [id])
  useEffect(() => onStatus(updatedAt, error), [updatedAt, error, onStatus])

  // 返信先はこのセッションだけなので、行数はこの画面のターン完了の行数（入力の行は返信の終わりではない）
  const turns = data?.rows.reduce((n, r) => n + (eventKind(r.event) === 'turn' ? 1 : 0), 0) ?? 0
  const { pending, failed, send } = useReply((target) => (target === id ? turns : 0), data?.replying ?? NO_REPLYING, updatedAt)
  const mine = pending.find((p) => p.id === id) ?? null
  const now = updatedAt?.getTime() ?? 0
  const failedHere = failed && failed.id === id ? failed.message : null

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
            {s.waiting && <WaitingTag text={s.waiting} />}
            {mine && <ReplyingTag since={mine.since} now={now} />}
            {s.archived && <ArchivedTag />}
          </span>
          {/* 合成 ID は集計の切れ方で付け先がずれるのでアーカイブできない */}
          {s.session_source !== 'synth' && <ArchiveButton key={`${s.id}:${s.archived ? 1 : 0}`} id={s.id} archived={Boolean(s.archived)} />}
          <MetaEditor key={s.id} id={s.id} meta={s.meta} />
          {s.title_full && <div className="meta wide">{s.title_full}</div>}
        </div>
      )}
      {error && !data && <div className="empty">{error}</div>}
      {data && (
        <Chat
          rows={data.rows}
          showChannel={false}
          sessions={[data.session]}
          trailer={mine && <PendingBubble text={mine.text} since={mine.since} now={now} quiet={promptArrived(data.rows, id, mine.text, mine.since)} />}
        />
      )}
      {s &&
        (s.archived ? (
          <div className="notice">アーカイブ済みのセッションには返信できません。続けるなら「戻す」を押してください（端末で続けて新しい行が届けば自動で戻ります）</div>
        ) : blocked ? (
          <div className="notice">{blocked}</div>
        ) : (
          <ReplyBox repo={s.repo} busy={mine !== null} busySince={mine?.since} now={now} onSend={(text) => void send(id, text)} />
        ))}
      {failedHere && <div className="notice error">送信失敗: {failedHere}</div>}
    </section>
  )
}
