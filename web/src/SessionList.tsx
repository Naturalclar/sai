import type { SessionFilters, SessionsResponse } from './api'
import type { Polled } from './hooks'
import { DaysSelect } from './DaysSelect'
import { FacetSelect } from './FacetSelect'
import { SessionItem } from './SessionItem'

interface Props {
  /** 一覧の取得結果。ポーリングは App が持つ（フィードの @ の候補にも使う） */
  list: Polled<SessionsResponse>
  filters: SessionFilters
  setFilters: (next: Partial<SessionFilters>) => void
  /** 右側で開いているセッションのID。無ければフィード */
  selectedId: string | null
}

/** 左サイドバー。絞り込み、固定の「フィード」、その下にセッション一覧（新しい順） */
export function SessionList({ list, filters, setFilters, selectedId }: Props) {
  const { data, error, updatedAt } = list
  const now = updatedAt?.getTime() ?? 0
  const archived = filters.archived === '1'

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
        <button
          type="button"
          className={archived ? 'on' : ''}
          aria-pressed={archived}
          title="アーカイブ済みのセッションだけを出す。新しい行が届いたものは自動で戻っている"
          onClick={() => setFilters({ archived: archived ? '' : '1' })}
        >
          {archived ? 'アーカイブ済みを見ている' : 'アーカイブ済みを見る'}
        </button>
        {data && <span className="count">{sessions.length} / {data.total} セッション</span>}
      </div>
      {error && <div className="side-error">取得失敗: {error}</div>}
      <nav className="channels">
        <a className={`item feed${selectedId === null ? ' active' : ''}`} href="#/feed">
          <span className="t">フィード</span>
          <span className="last">{filters.repo ? `#${filters.repo}` : '全リポジトリ'}を時系列に</span>
        </a>
        {archived && <div className="head">アーカイブ済み（薄く出る。開いて「戻す」か、新しい行が届けば自動で戻る）</div>}
        {sessions.map((s) => <SessionItem key={s.id} s={s} active={s.id === selectedId} replying={data?.replying[s.id] ?? null} approval={data?.approvals[s.id]?.[0] ?? null} now={now} />)}
      </nav>
      {data && sessions.length === 0 && <div className="empty">{archived ? 'アーカイブ済みのセッションはありません' : 'この条件のセッションはありません'}</div>}
    </>
  )
}

