import { useEffect } from 'react'
import { api, type SessionFilters, type SessionSummary } from './api'
import { useLocalState, usePolling } from './hooks'
import { hm, md, ymd } from './format'
import { AgentChip, SynthTag } from './AgentChip'
import { DaysSelect, FacetSelect } from './Select'
import type { StatusProps } from './App'

const DEFAULT: SessionFilters = { repo: '', agent: '', date: '', days: '7' }

export function SessionList({ onStatus }: StatusProps) {
  const [filters, setFilters] = useLocalState<SessionFilters>('sai.filters', DEFAULT)
  const { data, error, updatedAt } = usePolling(() => api.sessions(filters), [filters.repo, filters.agent, filters.date, filters.days])

  useEffect(() => onStatus(updatedAt, error), [updatedAt, error, onStatus])

  const facets = data?.filters ?? { repos: [], agents: [], dates: [] }
  const sessions = data?.sessions ?? []

  return (
    <section>
      <div className="filters">
        <FacetSelect label="リポジトリ" value={filters.repo} options={facets.repos} onChange={(repo) => setFilters({ repo })} />
        <FacetSelect label="エージェント" value={filters.agent} options={facets.agents} onChange={(agent) => setFilters({ agent })} />
        <FacetSelect label="日付" value={filters.date} options={facets.dates} onChange={(date) => setFilters({ date })} />
        <DaysSelect value={filters.days} options={[1, 3, 7, 30, 90]} onChange={(days) => setFilters({ days })} />
        <button type="button" onClick={() => setFilters({ repo: '', agent: '', date: '' })}>絞り込みを消す</button>
        {data && <span className="count">{sessions.length} / {data.total} セッション</span>}
      </div>
      <table>
        <thead>
          <tr>
            <th>開始 – 終了</th>
            <th>エージェント</th>
            <th>リポジトリ / ブランチ</th>
            <th className="num">ターン</th>
            <th>タイトル</th>
          </tr>
        </thead>
        <tbody>
          {sessions.map((s) => <Row key={s.id} s={s} />)}
        </tbody>
      </table>
      {data && sessions.length === 0 && <div className="empty">この条件のセッションはありません</div>}
    </section>
  )
}

function Span({ start, end }: { start: string; end: string }) {
  const same = ymd(start) === ymd(end)
  return (
    <>
      <b>{md(start)}</b> {hm(start)} – {same ? hm(end) : <><b>{md(end)}</b> {hm(end)}</>}
    </>
  )
}

const More = ({ n }: { n: number }) => (n > 1 ? <span className="more">+{n - 1}</span> : null)

function Row({ s }: { s: SessionSummary }) {
  return (
    <tr onClick={() => { location.hash = `#/s/${encodeURIComponent(s.id)}` }} title={s.id}>
      <td className="time"><Span start={s.start} end={s.end} /></td>
      <td><AgentChip agent={s.agent} /></td>
      <td>
        <span className="repo">
          {s.repo || '—'}<More n={s.repos.length} />
          {s.branch && <span className="br"> / {s.branch}<More n={s.branches.length} /></span>}
        </span>
      </td>
      <td className="num">{s.turns}</td>
      <td className="title">
        <span className="t" title={s.title_full}>
          {s.title || '(無題)'}
          {s.session_source === 'synth' && <SynthTag />}
        </span>
        {s.turns > 1 && s.last_text && <span className="last">{s.last_text}</span>}
      </td>
    </tr>
  )
}
