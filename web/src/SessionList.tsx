import { useState, useEffect, useRef } from 'react'
import type { PointerEvent } from 'react'
import type { SessionFilters, SessionsResponse } from './api'
import type { Polled } from './hooks'
import { useMediaQuery } from './hooks'
import { DaysSelect } from './DaysSelect'
import { FacetSelect } from './FacetSelect'
import { SessionItem } from './SessionItem'
import type { NavTarget } from './sessionNav'
import { todoItems } from './todoItems'

interface Props {
  /** 一覧の取得結果。ポーリングは App が持つ（フィードの @ の候補にも使う） */
  list: Polled<SessionsResponse>
  filters: SessionFilters
  setFilters: (next: Partial<SessionFilters>) => void
  /** サイドバーで選ばれている項目（固定の「フィード」「要対応」もここに入る） */
  active: NavTarget
  /** 新しいセッションの画面（`#/new`。#314）を開いている。キーボードの移動先ではないので active とは別に持つ */
  creating?: boolean
}

/** 左サイドバー。絞り込み、固定の「フィード」、その下にセッション一覧（新しい順） */
export function SessionList({ list, filters, setFilters, active, creating = false }: Props) {
  // キーボードで固定項目に移ったとき、サイドバーの一番上まで見えるようにする（SessionItem と同じ扱い）
  const pinnedRef = useRef<HTMLAnchorElement>(null)
  const pinned = active.kind === 'feed' || active.kind === 'todo'
  useEffect(() => {
    if (pinned) pinnedRef.current?.scrollIntoView({ block: 'nearest' })
  }, [pinned])

  const { data, error, updatedAt } = list
  const now = updatedAt?.getTime() ?? 0
  const archived = filters.archived === '1'

  const facets = data?.filters ?? { projects: [], repos: [], agents: [], dates: [], hosts: [] }
  const sessions = data?.sessions ?? []
  // バッジの数は要対応の画面と必ず同じ引数で数える（replying を渡し忘れると件数だけずれる。#232）
  const todo = data ? todoItems(data.sessions, data.approvals, data.host, data.replying).length : 0

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
        {/* どのマシンで記録されたか（#114）。集めていなければ 1 台しか無いので出さない */}
        {(facets.hosts.length > 1 || filters.host) && (
          <FacetSelect label="マシン" value={filters.host} options={facets.hosts} onChange={(host) => setFilters({ host })} />
        )}
        <FacetSelect label="エージェント" value={filters.agent} options={facets.agents} onChange={(agent) => setFilters({ agent })} />
        <FacetSelect label="日付" value={filters.date} options={facets.dates} onChange={(date) => setFilters({ date })} />
        <DaysSelect value={filters.days} options={[1, 3, 7, 30, 90]} onChange={(days) => setFilters({ days })} />
        <button type="button" onClick={() => setFilters({ project: '', repo: '', agent: '', date: '', host: '' })}>絞り込みを消す</button>
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
        <a ref={pinnedRef} className={`item feed${active.kind === 'feed' && !creating ? ' active' : ''}`} href="#/feed">
          <span className="t">フィード</span>
          <span className="last">{filters.repo ? `#${filters.repo}` : '全セッション'}を時系列に</span>
        </a>
        {/* 要対応（#224）。件数は一覧と同じ取得結果から数えるので、ここでも取りに行かない */}
        <a className={`item todo${active.kind === 'todo' ? ' active' : ''}`} href="#/todo">
          <span className="t">要対応{todo > 0 && <span className="n">{todo}</span>}</span>
          <span className="last">{todo > 0 ? 'あなたを待っています' : '待っているものはありません'}</span>
        </a>
        {/* 新しいセッション（#314）。worktree は記録にあるものから選ぶ */}
        <a className={`item new${creating ? ' active' : ''}`} href="#/new">
          <span className="t">＋ 新しいセッション</span>
          <span className="last">記録にある worktree で Claude を始める</span>
        </a>
        {archived && <div className="head">アーカイブ済み（薄く出る。開いて「戻す」か、新しい行が届けば自動で戻る）</div>}
        {sessions.map((s) => (
          <SessionItem
            key={s.id}
            s={s}
            active={active.kind === 'session' && s.id === active.id}
            replying={data?.replying[s.id] ?? null}
            {...(data?.profile ? { profile: data.profile } : {})}
            approval={data?.approvals[s.id]?.[0] ?? null}
            now={now}
            swipe={swipe}
            selfHost={data?.host ?? ''}
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

