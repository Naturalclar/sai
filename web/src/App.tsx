import { useCallback, useEffect, useMemo, useState } from 'react'
import { useHashRoute, useLocalState, usePolling } from './hooks'
import { SessionList } from './SessionList'
import { SessionView } from './SessionView'
import { FeedView } from './FeedView'
import { hm } from './format'
import { MenuMark } from './MenuMark'
import { GitHubMark } from './GitHubMark'
import { UserMenu } from './UserMenu'
import { api, type SessionFilters } from './api'
import { isTypingTarget, navAction, neighborSessionId } from './sessionNav'
import { PersonaSelect } from './PersonaSelect'
import { useSettings } from './useSettings'
import { RECORD_VERSION } from '../../shared/types.ts'

export interface StatusProps {
  onStatus: (updatedAt: Date | null, error: string | null) => void
}

/** 右ペイン（チャット）に渡すもの。「← 一覧」が広い画面ではサイドバーを開くだけなので、その口も渡す */
export interface PaneProps extends StatusProps {
  onOpenSidebar: () => void
}

const DEFAULT_FILTERS: SessionFilters = { repo: '', agent: '', date: '', days: '7', archived: '' }

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
  // 一覧はここで1回だけ取り、サイドバー（表示）とフィード（@ の候補）の両方に渡す。同じ URL を2回叩かない
  const list = usePolling(() => api.sessions(filters), [filters.repo, filters.agent, filters.date, filters.days, filters.archived])

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

  // ↑↓（j / k）でサイドバーの並びのまま隣のセッションへ、Esc でフィードへ。起点は「いま開いているセッション」なので state は持たない。
  // 入力欄にフォーカスがあるときはそちらの操作（caret の移動、@ の候補）なので触らない。サイドバーを閉じていても効く
  const selectedId = route.name === 'session' ? route.id : null
  const sessionIds = useMemo(() => list.data?.sessions.map((s) => s.id) ?? [], [list.data])
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const action = navAction(e)
      if (!action || isTypingTarget(e.target as HTMLElement | null)) return
      if (action === 'feed') {
        if (selectedId === null) return
        e.preventDefault()
        location.hash = '#/feed'
        return
      }
      const to = neighborSessionId(sessionIds, selectedId, action)
      // 端では何もしない。preventDefault もしない（ページのスクロールに残す）
      if (to === null) return
      e.preventDefault()
      location.hash = `#/s/${encodeURIComponent(to)}`
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [sessionIds, selectedId])

  useEffect(() => {
    document.title = route.name === 'session' ? `SAI · ${route.id.slice(0, 12)}` : 'SAI'
  }, [route])

  // 一言コメント（digest）の性格。サーバ側の設定なので取って来て、変えたら PUT。SAI_DIGEST=1 でないときは出さない
  const { settings, busy: settingsBusy, error: settingsError, setPersona } = useSettings()
  const [backfill, setBackfill] = useState<{ busy: boolean; note: string }>({ busy: false, note: '' })
  const runBackfill = async () => {
    setBackfill({ busy: true, note: '' })
    try {
      const r = await api.backfillDigest(20)
      setBackfill({ busy: false, note: r.queued ? `${r.queued} 件を作っています` : '作る行がありません' })
    } catch (err) {
      setBackfill({ busy: false, note: err instanceof Error ? err.message : String(err) })
    }
  }

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
          title={`${sidebarOpen ? '一覧を隠す' : '一覧を出す'} (⌘\\ / Ctrl+\\)\nセッションの移動: ↑↓ または k / j、フィードへ戻る: Esc`}
        >
          <MenuMark />
        </button>
        <div className="logo">
          SAI <small>agent-feed viewer</small>
        </div>
        {settings?.digest && (
          <div className="digest-ctl" title={settingsError || `一言コメント: ${settings.model}`}>
            <PersonaSelect value={settings.persona} busy={settingsBusy} onChange={(p) => void setPersona(p)} />
            <button type="button" className="linkish" onClick={() => void runBackfill()} disabled={backfill.busy} title="まだ一言が無い直近 20 件に一言を付ける（起動後に増えた行には自動で付く）">
              {backfill.busy ? '…' : '直近20件に一言'}
            </button>
            {(backfill.note || settingsError) && <span className="note">{settingsError || backfill.note}</span>}
          </div>
        )}
        <div className={`status${status.error ? ' error' : ''}`}>
          {status.error ? `取得失敗: ${status.error}` : status.at ? `更新 ${hm(status.at.toISOString())}` : ''}
        </div>
        {import.meta.env.REPO_URL && (
          <a className="github" href={import.meta.env.REPO_URL} target="_blank" rel="noopener noreferrer" aria-label="GitHub リポジトリ" title="GitHub リポジトリ">
            <GitHubMark />
          </a>
        )}
        <UserMenu profile={list.data?.profile} viewer={list.data?.viewer ?? null} />
      </header>
      {/* 記録側の record.py が古い（フックが古い checkout や試作を呼んでいる）。窓の中の一番新しい行の v で見る */}
      {list.data && list.data.record_version > 0 && list.data.record_version < RECORD_VERSION && (
        <div className="banner" role="status">
          記録側の <code>record.py</code> が古い（v{list.data.record_version}、最新は v{RECORD_VERSION}）。フックの向け先を確かめてください（README「1. フックを向ける」）
        </div>
      )}
      {/* 配っている web/dist/ がソースより古い（git pull のあと pnpm build していない）。pnpm dev は HMR で常に最新なので出さない */}
      {import.meta.env.PROD && list.data?.build_stale && (
        <div className="banner" role="status">
          画面のビルドが古い。別のターミナルで <code>pnpm build</code> してください（終わると自動で読み直す）
        </div>
      )}
      <main className={`layout route-${route.name}${sidebarOpen ? '' : ' sidebar-closed'}`}>
        <aside className="sidebar">
          {/* 幅を固定した箱に入れる。開閉の遷移中に列だけが縮み、中身は折り返さない */}
          <div className="side-inner">
            <SessionList list={list} filters={filters} setFilters={setFilters} selectedId={selectedId} />
          </div>
        </aside>
        <div className="pane">
          {route.name === 'session' ? (
            <SessionView id={route.id} onStatus={onStatus} onOpenSidebar={openSidebar} />
          ) : (
            <FeedView repo={filters.repo} sessions={list.data?.sessions} onStatus={onStatus} onOpenSidebar={openSidebar} />
          )}
        </div>
      </main>
    </>
  )
}

