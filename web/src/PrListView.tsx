import { RefreshButton } from './RefreshButton'
import { useCallback, useEffect, useState } from 'react'
import { api, type PrsResponse } from './api'
import { useLocalState } from './hooks'
import { BackLink } from './BackLink'
import { PrRow } from './PrRow'
import { filterRepos, requestedCount } from './prLabels'
import type { PaneProps } from './App'

interface Loaded {
  data: PrsResponse
  at: Date
}

/**
 * GitHub に出ている PR の一覧（#524）。**読むだけ**で、並べるのは SAI が記録で知っているリポジトリ（セッションの remote）の
 * open な PR。自分が出したもの以外も出す（他人のコードのレビューのため）。自分にレビューが頼まれているものを先に並べる。
 *
 * 3 秒のポーリングには乗せない（リポジトリの数だけ `gh` が走る）。開いたときに 1 回と、「更新」を押したときだけ取る
 */
export function PrListView({ onStatus, onOpenSidebar }: Pick<PaneProps, 'onStatus' | 'onOpenSidebar'>) {
  const [loaded, setLoaded] = useState<Loaded | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(true)
  const [ui, setUi] = useLocalState<{ requested: boolean }>('sai.prs', { requested: false })

  const load = useCallback((fresh: boolean) => {
    setBusy(true)
    return api.prs(fresh).then(
      (data) => {
        setLoaded({ data, at: new Date() })
        setError('')
        setBusy(false)
      },
      (err: unknown) => {
        setError(err instanceof Error ? err.message : String(err))
        setBusy(false)
      },
    )
  }, [])

  useEffect(() => {
    let alive = true
    void api.prs().then(
      (data) => alive && (setLoaded({ data, at: new Date() }), setBusy(false)),
      (err: unknown) => alive && (setError(err instanceof Error ? err.message : String(err)), setBusy(false)),
    )
    return () => {
      alive = false
    }
  }, [])

  // ヘッダの「更新 hh:mm」はこの取得に合わせる
  useEffect(() => onStatus(loaded?.at ?? null, error || null), [loaded, error, onStatus])

  const data = loaded?.data
  const repos = data ? filterRepos(data.repos, ui.requested) : []
  const requested = data ? requestedCount(data.repos) : 0
  const total = data ? data.repos.reduce((n, r) => n + r.prs.length, 0) : 0
  const now = loaded?.at.getTime() ?? 0

  return (
    <section className="pr-list-view">
      <BackLink onOpenSidebar={onOpenSidebar} />
      <div className="chat-head">
        <h1>PR</h1>
        <span className="meta">{data ? `${total} 件${requested > 0 ? `・あなたにレビュー依頼 ${requested} 件` : ''}` : ''}</span>
        <span className="pr-actions">
          <button type="button" className={ui.requested ? 'on' : ''} aria-pressed={ui.requested} onClick={() => setUi({ requested: !ui.requested })}>
            レビュー依頼だけ
          </button>
          <RefreshButton busy={busy} onClick={() => void load(true)} />
        </span>
      </div>
      {error && !data && <div className="empty">取得失敗: {error}</div>}
      {data && !data.available && <div className="empty">PR を読まない設定です（SAI_GH=0）</div>}
      {data && data.available && data.repos.length === 0 && (
        <div className="empty">GitHub のリポジトリのセッションが直近 30 日にありません（並べるのは記録にあるリポジトリだけです）</div>
      )}
      <div className="pr-list">
        {repos.map((r) => (
          <div className="pr-repo" key={r.repo}>
            <h2>
              <a href={`https://github.com/${r.repo}/pulls`} target="_blank" rel="noopener noreferrer" title="Open in GitHub">
                {r.repo}
              </a>
              <span className="n">{r.prs.length}</span>
            </h2>
            {r.error && <div className="none">{r.error}（gh が無いかログインしていない、または時間切れ）</div>}
            {!r.error && r.prs.length === 0 && <div className="none">open な PR はありません</div>}
            {r.prs.map((pr) => (
              <PrRow key={pr.number} repo={r.repo} pr={pr} now={now} />
            ))}
          </div>
        ))}
        {data && ui.requested && repos.length === 0 && <div className="empty">あなたにレビューが頼まれている PR はありません</div>}
      </div>
    </section>
  )
}
