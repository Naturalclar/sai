import { useEffect, useRef, useState } from 'react'
import { api, type SessionDiffResponse } from './api'
import { DiffView } from './DiffView'

/**
 * そのセッションの worktree の差分（#171）。開いたときに 1 回だけ取る（3 秒のポーリングには乗せない）。
 * 上が「ブランチの差分」（GitHub の PR で見るのと同じ base...HEAD）、下が「未コミット」。読むだけ
 */
export function DiffModal({ id, onClose }: { id: string; onClose: () => void }) {
  const [data, setData] = useState<SessionDiffResponse | null>(null)
  const [error, setError] = useState('')
  const dialogRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    dialogRef.current?.focus()
    let alive = true
    api
      .diff(id)
      .then((d) => alive && setData(d))
      .catch((err: unknown) => alive && setError(err instanceof Error ? err.message : String(err)))
    return () => {
      alive = false
    }
  }, [id])

  const truncated = Boolean(data && (data.branch.truncated || data.working.truncated))
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div
        className="modal diff"
        role="dialog"
        aria-modal="true"
        aria-label="このセッションの差分"
        tabIndex={-1}
        ref={dialogRef}
        onKeyDown={(e) => e.key === 'Escape' && onClose()}
      >
        <div className="title">このセッションの差分</div>
        {error && <div className="err">取得失敗: {error}</div>}
        {!data && !error && <div className="none">読んでいます…</div>}
        {data && (
          <>
            <div className="where">
              <code>{data.head || '(不明)'}</code>
              {data.base ? <> ← <code>{data.base}</code> からの差分</> : ' （比べる相手のブランチが見つかりません）'}
              {data.session_branch && data.head && data.session_branch !== data.head && (
                <div className="warn">このセッションが動いていたのは {data.session_branch} で、いまの worktree は {data.head} にいます</div>
              )}
            </div>
            {data.base && <DiffView section={data.branch} title="ブランチの差分" empty={`${data.base} との差はありません`} />}
            <DiffView section={data.working} title="未コミット" empty="コミットしていない変更はありません" />
            {data.untracked.length > 0 && (
              <div className="diff-section">
                <div className="head">
                  追跡外のファイル<span className="n">{data.untracked.length}</span>
                </div>
                <ul className="untracked">
                  {data.untracked.map((p) => (
                    <li key={p}><code>{p}</code></li>
                  ))}
                </ul>
              </div>
            )}
            {truncated && (
              <div className="warn">
                差分が大きいので一部は出していません。
                {data.compare_url && (
                  <>
                    {' '}
                    <a href={data.compare_url} target="_blank" rel="noopener noreferrer">GitHub で見る</a>
                  </>
                )}
              </div>
            )}
          </>
        )}
        <div className="actions">
          <button type="button" onClick={onClose}>閉じる</button>
        </div>
      </div>
    </div>
  )
}
