import { useCallback, useEffect, useState } from 'react'
import { api, type PrDetailResponse } from './api'
import { BackLink } from './BackLink'
import { sessionHash } from './hooks'
import { prHash } from '../../shared/prs.ts'
import { agoLabel } from './prLabels'
import { explainHref, explainPaneEmpty } from './prExplainLabels'
import { RefreshButton } from './RefreshButton'
import type { PaneProps } from './App'

interface Loaded {
  data: PrDetailResponse
  at: Date
}

/**
 * PR の解説のペイン（#887）。#881 の `/brief-pr` でできた HTML を、**今ある配る口（`GET /api/pr-explain/<鍵>`）のまま**
 * `sandbox` 付きの iframe で開く（スクリプトを動かさない・SAI と同じオリジンとして扱わせない。サーバも `CSP: sandbox` で配る）。
 *
 * - 鍵と状態は PR 1 本の取得（`api.pr()`）の `explain` から引く。取るのは開いたときと「更新」だけ（PR 1 本と同じ。ポーリングしない）
 * - 解説を作る・作り直すのは PR の画面（`PrExplainBox`）。ここには置かない
 */
export function PrExplainView({ repo, number, onStatus, onOpenSidebar }: { repo: string; number: number } & Pick<PaneProps, 'onStatus' | 'onOpenSidebar'>) {
  const [loaded, setLoaded] = useState<Loaded | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(true)

  const load = useCallback(() => {
    setBusy(true)
    return api.pr(repo, number).then(
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
  }, [repo, number])

  // PR が変われば key で作り直すので、ここでは 1 回取るだけ
  useEffect(() => {
    let alive = true
    void api.pr(repo, number).then(
      (data) => alive && (setLoaded({ data, at: new Date() }), setBusy(false)),
      (err: unknown) => alive && (setError(err instanceof Error ? err.message : String(err)), setBusy(false)),
    )
    return () => {
      alive = false
    }
  }, [repo, number])
  useEffect(() => onStatus(loaded?.at ?? null, error || null), [loaded, error, onStatus])

  const pr = loaded?.data.pr
  const explain = loaded?.data.explain ?? null
  const empty = loaded ? explainPaneEmpty(explain, loaded.data.explain_available === true) : ''
  const href = explain?.state === 'ready' && explain.key ? explainHref(explain.key) : ''

  return (
    <section className="pr-explain-view">
      <BackLink onOpenSidebar={onOpenSidebar} />
      <div className="chat-head">
        <h1>
          解説: {pr ? pr.title : repo} <span className="num">#{number}</span>
        </h1>
        <span className="pr-actions">
          {href && (
            <a className="pr-explain-link" href={href} target="_blank" rel="noopener noreferrer">
              新しいタブで開く
            </a>
          )}
          <a className="pr-explain-link" href={prHash(repo, number)}>
            PR を開く
          </a>
          <RefreshButton busy={busy} onClick={() => void load()} />
        </span>
      </div>
      {explain && loaded && (
        <div className="pr-explain-meta">
          {explain.stale && <span className="tag stale">古い解説（作ったあとに push がありました）</span>}
          <a className="session" href={sessionHash(explain.session)}>
            {agoLabel(explain.at, loaded.at.getTime())}に回したセッション
          </a>
        </div>
      )}
      {error && !loaded && <div className="empty">取得失敗: {error}</div>}
      {!loaded && !error && <div className="empty">読んでいます…</div>}
      {empty && <div className="empty">{empty}</div>}
      {href && (
        // sandbox は空（何も許さない）。サーバの CSP の sandbox と二重にかける
        <iframe className="pr-explain-frame" src={href} sandbox="" referrerPolicy="no-referrer" title={`PR #${number} の解説`} />
      )}
    </section>
  )
}
