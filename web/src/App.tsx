import { useCallback, useEffect, useState } from 'react'
import { useHashRoute, useLocalState } from './hooks'
import { SessionList } from './SessionList'
import { SessionView } from './SessionView'
import { FeedView } from './FeedView'
import { hm } from './format'
import type { SessionFilters } from './api'

export interface StatusProps {
  onStatus: (updatedAt: Date | null, error: string | null) => void
}

/** 右ペイン（チャット）に渡すもの。「← 一覧」が広い画面ではサイドバーを開くだけなので、その口も渡す */
export interface PaneProps extends StatusProps {
  onOpenSidebar: () => void
}

const DEFAULT_FILTERS: SessionFilters = { repo: '', agent: '', date: '', days: '7' }

/** 画面の見た目の状態。フィルタと同じく localStorage に残す */
interface UiState {
  sidebar: 'open' | 'closed'
}
const DEFAULT_UI: UiState = { sidebar: 'open' }

/**
 * 1画面。左のサイドバーにセッション一覧、右にチャット（フィード or 選んだセッション）。
 * `#/` と `#/feed` は広い画面では同じ表示（サイドバー + フィード）。狭い画面では `#/` が一覧だけ、
 * `#/feed` と `#/s/<id>` がチャットだけになる（CSS の main.route-* で切り替える）。
 */
export function App() {
  const route = useHashRoute()
  // ヘッダの「更新 hh:mm」は右側（チャット）の分だけ。サイドバーは自分の失敗を自分の中に出す
  const [status, setStatus] = useState<{ at: Date | null; error: string | null }>({ at: null, error: null })
  // 子の useEffect の依存に入るので、毎回作り直すと無限に再描画する
  const onStatus = useCallback<StatusProps['onStatus']>((at, error) => setStatus({ at, error }), [])

  // 絞り込みはサイドバーのもの。フィードのリポジトリはこれに従う（同じ画面に「リポジトリ」を2つ出さない）
  const [filters, setFilters] = useLocalState<SessionFilters>('sai.filters', DEFAULT_FILTERS)

  // サイドバーの開閉。レイアウトは main の class で CSS が切り替える。狭い画面では CSS 側が無視する
  const [ui, setUi] = useLocalState<UiState>('sai.ui', DEFAULT_UI)
  const sidebarOpen = ui.sidebar !== 'closed'
  const toggleSidebar = useCallback(() => setUi({ sidebar: sidebarOpen ? 'closed' : 'open' }), [setUi, sidebarOpen])
  const openSidebar = useCallback(() => setUi({ sidebar: 'open' }), [setUi])

  // Cmd/Ctrl + \ で開閉（VS Code と同じ）。入力欄にフォーカスがあっても効く。IME 変換中は無視
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== '\\' || !(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey) return
      if (e.isComposing) return
      e.preventDefault()
      toggleSidebar()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [toggleSidebar])

  useEffect(() => {
    document.title = route.name === 'session' ? `SAI · ${route.id.slice(0, 12)}` : 'SAI'
  }, [route])

  return (
    <>
      <header>
        <button
          type="button"
          className="sidebar-toggle"
          onClick={toggleSidebar}
          aria-expanded={sidebarOpen}
          aria-keyshortcuts="Meta+\ Control+\"
          aria-label={sidebarOpen ? '一覧を隠す' : '一覧を出す'}
          title={`${sidebarOpen ? '一覧を隠す' : '一覧を出す'} (⌘\\ / Ctrl+\\)`}
        >
          <MenuMark />
        </button>
        <div className="logo">
          SAI <small>agent-feed viewer</small>
        </div>
        <div className={`status${status.error ? ' error' : ''}`}>
          {status.error ? `取得失敗: ${status.error}` : status.at ? `更新 ${hm(status.at.toISOString())}` : ''}
        </div>
        {import.meta.env.REPO_URL && (
          <a className="github" href={import.meta.env.REPO_URL} target="_blank" rel="noopener noreferrer" aria-label="GitHub リポジトリ" title="GitHub リポジトリ">
            <GitHubMark />
          </a>
        )}
      </header>
      <main className={`layout route-${route.name}${sidebarOpen ? '' : ' sidebar-closed'}`}>
        <aside className="sidebar">
          <SessionList filters={filters} setFilters={setFilters} selectedId={route.name === 'session' ? route.id : null} />
        </aside>
        <div className="pane">
          {route.name === 'session' ? (
            <SessionView id={route.id} onStatus={onStatus} onOpenSidebar={openSidebar} />
          ) : (
            <FeedView repo={filters.repo} onStatus={onStatus} onOpenSidebar={openSidebar} />
          )}
        </div>
      </main>
    </>
  )
}

/** サイドバー開閉の「≡」。色は currentColor に任せる */
function MenuMark() {
  return (
    <svg viewBox="0 0 16 16" width="20" height="20" aria-hidden="true" fill="currentColor">
      <path d="M1 3.5A.5.5 0 0 1 1.5 3h13a.5.5 0 0 1 0 1h-13a.5.5 0 0 1-.5-.5zm0 4.5a.5.5 0 0 1 .5-.5h13a.5.5 0 0 1 0 1h-13A.5.5 0 0 1 1 8zm0 4.5a.5.5 0 0 1 .5-.5h13a.5.5 0 0 1 0 1h-13a.5.5 0 0 1-.5-.5z" />
    </svg>
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
