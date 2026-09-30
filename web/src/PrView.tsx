import { useCallback, useEffect, useState } from 'react'
import { api, type PrDetailResponse } from './api'
import { DiffView } from './DiffView'
import { Markdown } from './Markdown'
import { agoLabel, checkLabel, reviewLabel } from './prLabels'
import type { PaneProps } from './App'

interface Loaded {
  data: PrDetailResponse
  at: Date
}

const STATE_LABEL: Record<string, string> = { OPEN: 'open', MERGED: 'マージ済み', CLOSED: '閉じた' }

/**
 * PR 1 本（#524）。題名・出した人・ブランチ・チェック・本文と、差分を**セッションの差分と同じビューア**（`DiffView`）で出す。
 * **読むだけ**（行へのコメントと GitHub への投稿は #525 / #526）。開いたときに 1 回と「読み直す」のときだけ取る
 */
export function PrView({ repo, number, onStatus }: { repo: string; number: number } & Pick<PaneProps, 'onStatus'>) {
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

  // 別の PR に移ったら前の PR の中身は出さない（key で作り直すので、ここでは 1 回取るだけ）
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
  const check = pr ? checkLabel(pr.checks) : null
  const review = pr ? reviewLabel(pr.review_decision) : ''

  return (
    <section className="pr-view">
      <a className="back pr-back" href="#/prs">← PR 一覧</a>
      <div className="chat-head">
        <h1>
          {pr ? pr.title : `${repo}#${number}`} <span className="num">#{number}</span>
        </h1>
        <span className="pr-actions">
          {pr?.url && (
            <a href={pr.url} target="_blank" rel="noopener noreferrer">
              GitHub で開く
            </a>
          )}
          <button type="button" onClick={() => void load()} disabled={busy}>
            {busy ? '読んでいます…' : '読み直す'}
          </button>
        </span>
      </div>
      {error && !loaded && <div className="empty">取得失敗: {error}</div>}
      {!loaded && !error && <div className="empty">読んでいます…</div>}
      {pr && loaded && (
        <div className="pr-body">
          <div className="pr-meta">
            <span className={`tag state ${pr.state.toLowerCase()}`}>{STATE_LABEL[pr.state] ?? pr.state}</span>
            {pr.draft && <span className="tag">下書き</span>}
            {pr.requested && <span className="tag requested">レビュー依頼</span>}
            <span className="author">{pr.author}</span>
            <span>
              <code>{pr.head}</code> → <code>{pr.base}</code>
            </span>
            {check && (
              <span className={`check ${pr.checks}`} title={check.title}>
                {check.mark} {check.title}
              </span>
            )}
            {review && <span className={`review ${pr.review_decision.toLowerCase()}`}>{review}</span>}
            <span className="ago">{agoLabel(pr.updated_at, loaded.at.getTime())}に更新</span>
            <span className="repo">{loaded.data.repo}</span>
          </div>
          <div className="pr-description body">{pr.body.trim() ? <Markdown text={pr.body} /> : <span className="none">本文はありません</span>}</div>
          {loaded.data.diff_error && <div className="warn">{loaded.data.diff_error}</div>}
          {!loaded.data.diff_error && (
            <DiffView section={loaded.data.diff} title="変更" empty="差分はありません" />
          )}
          {loaded.data.diff.truncated && (
            <div className="warn">
              差分が大きいので一部は出していません。{' '}
              <a href={`${pr.url}/files`} target="_blank" rel="noopener noreferrer">GitHub で見る</a>
            </div>
          )}
        </div>
      )}
    </section>
  )
}
