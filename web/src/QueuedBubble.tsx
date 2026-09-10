import { useState } from 'react'
import { splitAttachments } from '../../shared/attachments.ts'
import { api, type Profile, type QueuedReply } from './api'
import { AttachedImages } from './AttachedImages'
import { elapsedLabel, hm } from './format'
import { queuedLabel } from './replyQueue.ts'

interface Props {
  /** 返信先のエンティティID */
  id: string
  item: QueuedReply
  /** 何番目に回るか（1 始まり） */
  order: number
  /** そのセッションの預かりを止めている理由。止めていなければ空 */
  paused: string
  /** 経過の基準（ポーリングの updatedAt） */
  now: number
  /** フィードではチャンネル名を添える */
  repo?: string
  profile?: Profile
}

/**
 * 処理中に送って預かっている返信（#305）。前のターンが終わるとサーバが古い順に 1 件ずつ回し、回したものは
 * 処理中の仮バブル（`PendingBubble`）に移ってここからは消える。まだ回していないものだけ取り消せる。
 * `paused`（前の返信が失敗した・起動できなかった）の間は自動では回さないので、先頭に理由と「続けて送る」を出す
 */
export function QueuedBubble({ id, item, order, paused, now, repo, profile }: Props) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const act = async (call: () => Promise<unknown>) => {
    setBusy(true)
    setError('')
    try {
      await call()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }
  const { body, urls } = splitAttachments(item.text)
  // 止めている理由と「続けて送る」は先頭にだけ出す（止めるのはセッション単位で、回すのは先頭から）
  const head = order === 1 && paused !== ''
  return (
    <div className="group pending queued">
      <div className="avatar me">{profile?.icon ? <img src={profile.icon} alt="" /> : '私'}</div>
      <div>
        <div className="gh">
          <span className="name">{profile?.name || 'あなた'}</span>
          {repo && <span className="ch">#{repo}</span>}
          <span className="time" title={`${hm(item.since)} に預けた。前の返信が終わったら続けて回す`}>
            {queuedLabel(order, elapsedLabel(item.since, now))}
          </span>
        </div>
        <div className="msg">
          <div className="body">{body}</div>
          <AttachedImages urls={urls} />
          {head && <div className="queue-note">{paused}</div>}
          <div className="queue-actions">
            {head && (
              <button type="button" disabled={busy} onClick={() => void act(() => api.resumeQueue(id))}>
                続けて送る
              </button>
            )}
            <button type="button" disabled={busy} onClick={() => void act(() => api.cancelQueued(id, item.queue_id))}>
              取り消す
            </button>
          </div>
          {error && <div className="empty-text">{error}</div>}
        </div>
      </div>
    </div>
  )
}
