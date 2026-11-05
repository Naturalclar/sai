import { useEffect, useMemo, useRef, useState } from 'react'
import { api } from './api'
import { usePolling } from './hooks'
import { BackLink } from './BackLink'
import { DotsConversationBlock } from './DotsConversationBlock'
import { DotsComposer } from './DotsComposer'
import { dotsTarget, dotsTimeline } from './dotsLog.ts'
import type { DotsConversation } from '../../shared/dots.ts'
import type { PaneProps } from './App'

const NO_CONVERSATIONS: DotsConversation[] = []

/**
 * dots との会話ログ（#872）。受信箱（`~/.agent-feed/dots-inbox.jsonl`）の会話を、フィードと同じく古いものを上に時系列で並べる。
 * 入力欄から新しい会話を始めるか、選んだ会話に続けて投稿する。
 *
 * **いまは配信しない**（届ける口は受信箱のアダプター #873）ので、投稿は「未配信」のまま。返答は Markdown を文字として描く
 */
export function DotsView({ onStatus, onOpenSidebar }: Pick<PaneProps, 'onStatus' | 'onOpenSidebar'>) {
  // 送ったら待たずに取り直す（deps を変えて張り直す。resetKey が同じなので出ているものは消さない）
  const [nonce, setNonce] = useState(0)
  const { data, error, updatedAt } = usePolling(() => api.dots(), [nonce], { resetKey: 'dots' })
  useEffect(() => onStatus(updatedAt, error), [updatedAt, error, onStatus])

  const conversations = data?.conversations ?? NO_CONVERSATIONS
  const timeline = useMemo(() => dotsTimeline(conversations), [conversations])
  // 送り先（会話の id）。null は新しい会話。送った直後の会話は一覧が追いつくまで `pending` で残す
  const [target, setTarget] = useState<string | null>(null)
  const [pending, setPending] = useState<string | null>(null)
  const current = dotsTarget(target, conversations, pending)

  // 新しい投稿・返答が来たら下まで送る（並びの最後の時刻が変わったときだけ）
  const listRef = useRef<HTMLDivElement>(null)
  const lastAt = timeline.at(-1)?.updated_at ?? ''
  useEffect(() => {
    const el = listRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [lastAt])

  const send = async (text: string) => {
    const conversationId = current === null ? undefined : typeof current === 'string' ? current : current.id
    const { message } = await api.dotsPost(text, conversationId)
    setPending(message.conversation_id)
    setTarget(message.conversation_id)
    setNonce((n) => n + 1)
  }

  return (
    <section className="dots-view">
      <BackLink onOpenSidebar={onOpenSidebar} />
      <div className="chat-head">
        <h1>dots との会話</h1>
        <span className="meta">まだ dots には届けていません（受信箱に置くだけ）</span>
      </div>
      <div className="chat dots-log" ref={listRef}>
        {timeline.length === 0 ? (
          <div className="empty">{data ? 'まだ会話がありません。下の入力欄から始めます' : '読み込み中…'}</div>
        ) : (
          timeline.map((c) => <DotsConversationBlock key={`conv:${c.id}`} conversation={c} selected={typeof current === 'object' && current?.id === c.id} onSelect={() => setTarget(c.id)} />)
        )}
      </div>
      <DotsComposer target={current} onNew={() => setTarget(null)} onSend={send} />
    </section>
  )
}
