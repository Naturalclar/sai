import { api, type SessionFilters, type SessionSummary } from './api'
import { usePolling } from './hooks'
import { hm, md } from './format'
import { SynthTag } from './AgentChip'
import { DaysSelect, FacetSelect } from './Select'
import { stripMarkdown } from '../../shared/markdown.ts'

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
        {sessions.map((s) => <Item key={s.id} s={s} active={s.id === selectedId} />)}
      </nav>
      {data && sessions.length === 0 && <div className="empty">この条件のセッションはありません</div>}
    </>
  )
}

const More = ({ n }: { n: number }) => (n > 1 ? <span className="more">+{n - 1}</span> : null)

function Item({ s, active }: { s: SessionSummary; active: boolean }) {
  return (
    <a className={`item${active ? ' active' : ''}`} href={`#/s/${encodeURIComponent(s.id)}`} title={s.id}>
      <span className="top">
        <span className="repo">
          <span className={`dot ${s.agent}`} />
          {s.repo || '—'}<More n={s.repos.length} />
          {s.branch && <span className="br"> / {s.branch}<More n={s.branches.length} /></span>}
        </span>
        <span className="when"><b>{md(s.end)}</b> {hm(s.end)} · {s.turns}</span>
      </span>
      <span className="t" title={s.title_full}>
        {s.title || '(無題)'}
        {s.session_source === 'synth' && <SynthTag />}
      </span>
      {s.turns > 1 && s.last_text && <span className="last">{stripMarkdown(s.last_text)}</span>}
    </a>
  )
}
