import { useEffect } from 'react'
import { api } from './api'
import { useLocalState, usePolling } from './hooks'
import { Chat } from './Chat'
import { DaysSelect } from './Select'
import type { StatusProps } from './App'

/** 全チャンネルを時系列に流す。リポジトリはサイドバーの絞り込みに従い、日数だけここで選ぶ */
export function FeedView({ repo, onStatus }: { repo: string } & StatusProps) {
  const [local, setLocal] = useLocalState<{ days: string }>('sai.feed', { days: '3' })
  const { data, error, updatedAt } = usePolling(() => api.feed({ repo, days: local.days }), [repo, local.days])
  useEffect(() => onStatus(updatedAt, error), [updatedAt, error, onStatus])

  return (
    <section>
      <a className="back" href="#/">← 一覧</a>
      <div className="chat-head">
        <h1>フィード</h1>
        <span className="meta">{repo ? `#${repo}` : '全リポジトリ'}{data && ` · ${data.rows.length} ターン · 直近${data.days}日`}</span>
        <span className="meta pull">
          <DaysSelect value={local.days} options={[1, 3, 7]} onChange={(days) => setLocal({ days })} />
        </span>
      </div>
      {error && !data && <div className="empty">{error}</div>}
      {data && <Chat rows={data.rows} showChannel />}
    </section>
  )
}
