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
      </header>
      <main>
        {route.name === 'list' && <SessionList onStatus={onStatus} />}
        {route.name === 'session' && <SessionView id={route.id} onStatus={onStatus} />}
        {route.name === 'feed' && <FeedView onStatus={onStatus} />}
      </main>
    </>
  )
}
