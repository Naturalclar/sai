import { useState, useEffect, useRef } from 'react'
import type { PointerEvent } from 'react'
import type { SessionFilters, SessionsResponse } from './api'
import type { Polled } from './hooks'
import { useMediaQuery } from './hooks'
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
  // キーボードでフィードに移ったとき、サイドバーの一番上まで見えるようにする（SessionItem と同じ扱い）
  const feedRef = useRef<HTMLAnchorElement>(null)
  useEffect(() => {
    if (selectedId === null) feedRef.current?.scrollIntoView({ block: 'nearest' })
  }, [selectedId])

  const { data, error, updatedAt } = list
  const now = updatedAt?.getTime() ?? 0
  const archived = filters.archived === '1'

  const facets = data?.filters ?? { projects: [], repos: [], agents: [], dates: [] }
  const sessions = data?.sessions ?? []

  // タッチ端末では項目を左にスワイプしてアーカイブを出す。開いている項目は 1 つだけ
  const swipe = useMediaQuery('(hover: none) and (pointer: coarse)')
  const reduced = useMediaQuery('(prefers-reduced-motion: reduce)')
  const [openId, setOpenId] = useState<string | null>(null)
  // 別の項目（か一覧のどこか）に触ったら閉じる
  const onPointerDownCapture = (e: PointerEvent<HTMLElement>) => {
    if (openId === null) return
    const item = (e.target as HTMLElement).closest<HTMLElement>('.item[data-id]')
    if (item?.dataset.id !== openId) setOpenId(null)
  }

  return (
    <>
      <div className="filters">
        {/* 値は repo フィールド（worktree ならそのディレクトリ名）。GitHub のリポジトリではないので画面では「セッション」と呼ぶ（#151） */}
        <FacetSelect label="リポジトリ" value={filters.project} options={facets.projects} onChange={(project) => setFilters({ project })} />
        {/* worktree（git の toplevel の basename）。bare clone だと 1 リポジトリに複数あるので、2 つ以上あるときだけ出す */}
        {(facets.repos.length > 1 || filters.repo) && (
          <FacetSelect label="worktree" value={filters.repo} options={facets.repos} onChange={(repo) => setFilters({ repo })} />
        )}
        <FacetSelect label="エージェント" value={filters.agent} options={facets.agents} onChange={(agent) => setFilters({ agent })} />
        <FacetSelect label="日付" value={filters.date} options={facets.dates} onChange={(date) => setFilters({ date })} />
        <DaysSelect value={filters.days} options={[1, 3, 7, 30, 90]} onChange={(days) => setFilters({ days })} />
        <button type="button" onClick={() => setFilters({ project: '', repo: '', agent: '', date: '' })}>絞り込みを消す</button>
        <button
          type="button"
          className={archived ? 'on' : ''}
          aria-pressed={archived}
          title="アーカイブ済みのセッションだけを出す。新しい行が届いたものは自動で戻っている"
          onClick={() => setFilters({ archived: archived ? '' : '1' })}
        >
          {archived ? 'アーカイブ済みを見ている' : 'アーカイブ済みを見る'}
        </button>
        {data && <span className="count">{sessions.length} / {data.total} 件</span>}
      </div>
      {error && <div className="side-error">取得失敗: {error}</div>}
      <nav className="channels" onPointerDownCapture={onPointerDownCapture}>
        <a ref={feedRef} className={`item feed${selectedId === null ? ' active' : ''}`} href="#/feed">
          <span className="t">フィード</span>
          <span className="last">{filters.repo ? `#${filters.repo}` : '全セッション'}を時系列に</span>
        </a>
        {archived && <div className="head">アーカイブ済み（薄く出る。開いて「戻す」か、新しい行が届けば自動で戻る）</div>}
        {sessions.map((s) => (
          <SessionItem
            key={s.id}
            s={s}
            active={s.id === selectedId}
            replying={data?.replying[s.id] ?? null}
            approval={data?.approvals[s.id]?.[0] ?? null}
            now={now}
            swipe={swipe}
            reduced={reduced}
            open={openId === s.id}
            onOpenChange={(open) => setOpenId(open ? s.id : openId === s.id ? null : openId)}
          />
        ))}
      </nav>
      {data && sessions.length === 0 && <div className="empty">{archived ? 'アーカイブ済みのセッションはありません' : 'この条件のセッションはありません'}</div>}
    </>
  )
}

