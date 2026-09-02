import { useCallback, useEffect, useState } from 'react'
import { useHashRoute } from './hooks'
import { SessionList } from './SessionList'
import { SessionView } from './SessionView'
import { FeedView } from './FeedView'
import { hm } from './format'

export interface StatusProps {
  onStatus: (updatedAt: Date | null, error: string | null) => void
}

export function App() {
  const route = useHashRoute()
  const [status, setStatus] = useState<{ at: Date | null; error: string | null }>({ at: null, error: null })
  // 子の useEffect の依存に入るので、毎回作り直すと無限に再描画する
  const onStatus = useCallback<StatusProps['onStatus']>((at, error) => setStatus({ at, error }), [])

  const navActive = route.name === 'feed' ? 'feed' : 'list'
  useEffect(() => {
    document.title = route.name === 'session' ? `SAI · ${route.id.slice(0, 12)}` : route.name === 'feed' ? 'SAI · フィード' : 'SAI'
  }, [route])

  return (
    <>
      <header>
        <div className="logo">
          SAI <small>agent-feed viewer</small>
        </div>
        <nav>
          <a href="#/" className={navActive === 'list' ? 'active' : ''}>セッション</a>
          <a href="#/feed" className={navActive === 'feed' ? 'active' : ''}>フィード</a>
        </nav>
        <div className={`status${status.error ? ' error' : ''}`}>
          {status.error ? `取得失敗: ${status.error}` : status.at ? `更新 ${hm(status.at.toISOString())}` : ''}
        </div>
        {import.meta.env.REPO_URL && (
          <a className="github" href={import.meta.env.REPO_URL} target="_blank" rel="noopener noreferrer" aria-label="GitHub リポジトリ" title="GitHub リポジトリ">
            <GitHubMark />
          </a>
        )}
      </header>
      <main>
        {route.name === 'list' && <SessionList onStatus={onStatus} />}
        {route.name === 'session' && <SessionView id={route.id} onStatus={onStatus} />}
        {route.name === 'feed' && <FeedView onStatus={onStatus} />}
      </main>
    </>
  )
}

/** GitHub のロゴ（Octicons の mark-github）。色は currentColor に任せる */
function GitHubMark() {
  return (
    <svg viewBox="0 0 16 16" width="20" height="20" aria-hidden="true" fill="currentColor">
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z" />
    </svg>
  )
}
