import { useEffect, useMemo, useState } from 'react'
import { entityId } from '../../shared/entity.ts'
import { feedReplyTargets } from '../../shared/reply.ts'
import { api } from './api'
import { useLocalState, usePolling } from './hooks'
import { Chat, PendingBubble } from './Chat'
import { ReplyBox } from './ReplyBox'
import { DaysSelect } from './Select'
import { BackLink } from './BackLink'
import { useReply } from './useReply'
import type { PaneProps } from './App'

const NO_ROWS: never[] = []

/** 全チャンネルを時系列に流す。リポジトリはサイドバーの絞り込みに従い、日数だけここで選ぶ */
export function FeedView({ repo, onStatus, onOpenSidebar }: { repo: string } & PaneProps) {
  const [local, setLocal] = useLocalState<{ days: string }>('sai.feed', { days: '3' })
  const { data, error, updatedAt } = usePolling(() => api.feed({ repo, days: local.days }), [repo, local.days])
  useEffect(() => onStatus(updatedAt, error), [updatedAt, error, onStatus])

  const rows = data?.rows ?? NO_ROWS
  // 返信先の候補と、返信先ごとの行数（「送信中」の解除に使う）はフィードの行から作る
  const targets = useMemo(() => feedReplyTargets(rows), [rows])
  const counts = useMemo(() => {
    const m = new Map<string, number>()
    for (const r of rows) {
      const id = entityId(r.session, r.repo, r.ts)
      m.set(id, (m.get(id) ?? 0) + 1)
    }
    return m
  }, [rows])

  // 手で選んだ返信先（id）。候補から消えたら（days やリポジトリの変更）既定に戻る
  const [pickedId, setPickedId] = useState<string | null>(null)
  const picked = pickedId ? (targets.find((t) => t.id === pickedId && !t.blocked) ?? null) : null
  // 既定は一番新しい行のセッション（再開できるもののうち）
  const target = picked ?? targets.find((t) => !t.blocked) ?? null

  const { pending, failed, send } = useReply((id) => counts.get(id) ?? 0)
  const repoOf = (id: string) => targets.find((t) => t.id === id)?.repo

  return (
    <section>
      <BackLink onOpenSidebar={onOpenSidebar} />
      <div className="chat-head">
        <h1>フィード</h1>
        <span className="meta">{repo ? `#${repo}` : '全リポジトリ'}{data && ` · ${data.rows.length} ターン · 直近${data.days}日`}</span>
        <span className="meta pull">
          <DaysSelect value={local.days} options={[1, 3, 7]} onChange={(days) => setLocal({ days })} />
        </span>
      </div>
      {error && !data && <div className="empty">{error}</div>}
      {data && (
        <Chat
          rows={rows}
          showChannel
          trailer={pending.length > 0 && pending.map((p) => <PendingBubble key={p.id} text={p.text} repo={repoOf(p.id)} />)}
        />
      )}
      {data &&
        (target ? (
          <ReplyBox
            repo={target.repo}
            busy={pending.some((p) => p.id === target.id)}
            onSend={(text) => void send(target.id, text)}
            mention={{ targets, target, picked: picked !== null, onPick: setPickedId }}
          />
        ) : (
          <div className="notice">返信できるセッションがありません</div>
        ))}
      {failed && <div className="notice error">送信失敗（{repoOf(failed.id) ? `#${repoOf(failed.id)}` : failed.id}）: {failed.message}</div>}
    </section>
  )
}
