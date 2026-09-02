import { useEffect, useMemo } from 'react'
import { api, type FeedFilters } from './api'
import { useLocalState, usePolling } from './hooks'
import { Chat } from './Chat'
import { DaysSelect, FacetSelect } from './Select'
import type { StatusProps } from './App'

const DEFAULT: FeedFilters = { repo: '', days: '3' }

export function FeedView({ onStatus }: StatusProps) {
  const [filters, setFilters] = useLocalState<FeedFilters>('sai.feed', DEFAULT)
  const { data, error, updatedAt } = usePolling(() => api.feed(filters), [filters.repo, filters.days])
  useEffect(() => onStatus(updatedAt, error), [updatedAt, error, onStatus])

  const repos = useMemo(() => [...new Set((data?.rows ?? []).map((r) => r.repo).filter(Boolean))].sort(), [data])

  return (
    <section>
      <a className="back" href="#/">← セッション一覧</a>
      <div className="chat-head">
        <h1>フィード</h1>
        {data && <span className="meta">全リポジトリ · {data.rows.length} ターン · 直近{data.days}日</span>}
      </div>
      <div className="filters">
        <FacetSelect label="リポジトリ" value={filters.repo} options={repos} onChange={(repo) => setFilters({ repo })} />
        <DaysSelect value={filters.days} options={[1, 3, 7]} onChange={(days) => setFilters({ days })} />
      </div>
      {data && <Chat rows={data.rows} showChannel />}
    </section>
  )
}
