import { api, type SessionFilters } from './api'
import { usePolling } from './hooks'
import { DaysSelect } from './DaysSelect'
import { FacetSelect } from './FacetSelect'
import { SessionItem } from './SessionItem'

interface Props {
  filters: SessionFilters
  setFilters: (next: Partial<SessionFilters>) => void
  /** 右側で開いているセッションのID。無ければフィード */
  selectedId: string | null
}

/** 左サイドバー。絞り込み、固定の「フィード」、その下にセッション一覧（新しい順） */
export function SessionList({ filters, setFilters, selectedId }: Props) {
  const { data, error } = usePolling(() => api.sessions(filters), [filters.repo, filters.agent, filters.date, filters.days])

  const facets = data?.filters ?? { repos: [], agents: [], dates: [] }
  const sessions = data?.sessions ?? []

  return (
    <>
      <div className="filters">
        <FacetSelect label="リポジトリ" value={filters.repo} options={facets.repos} onChange={(repo) => setFilters({ repo })} />
        <FacetSelect label="エージェント" value={filters.agent} options={facets.agents} onChange={(agent) => setFilters({ agent })} />
        <FacetSelect label="日付" value={filters.date} options={facets.dates} onChange={(date) => setFilters({ date })} />
        <DaysSelect value={filters.days} options={[1, 3, 7, 30, 90]} onChange={(days) => setFilters({ days })} />
        <button type="button" onClick={() => setFilters({ repo: '', agent: '', date: '' })}>絞り込みを消す</button>
        {data && <span className="count">{sessions.length} / {data.total} セッション</span>}
      </div>
      {error && <div className="side-error">取得失敗: {error}</div>}
      <nav className="channels">
        <a className={`item feed${selectedId === null ? ' active' : ''}`} href="#/feed">
          <span className="t">フィード</span>
          <span className="last">{filters.repo ? `#${filters.repo}` : '全リポジトリ'}を時系列に</span>
        </a>
        {sessions.map((s) => <SessionItem key={s.id} s={s} active={s.id === selectedId} />)}
      </nav>
      {data && sessions.length === 0 && <div className="empty">この条件のセッションはありません</div>}
    </>
  )
}

