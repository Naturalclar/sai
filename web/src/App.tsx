import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { HIDDEN_POLL_MS, parseRoute, useHashRoute, useLocalState, usePolling } from './hooks'
import { todoItems } from './todoItems'
import { titleWith } from './notify.ts'
import { useNotify } from './useNotify'
import { SessionList } from './SessionList'
import { SessionView } from './SessionView'
import { DiffPane } from './DiffPane'
import { DiffModal } from './DiffModal'
import { useNarrow } from './useNarrow'
import { FeedView } from './FeedView'
import { TodoView } from './TodoView'
import { hm } from './format'
import { MenuMark } from './MenuMark'
import { GitHubMark } from './GitHubMark'
import { UserMenu } from './UserMenu'
import { UsageChip } from './UsageChip'
import { api, type SessionFilters, type SettingsResponse } from './api'
import { isTypingTarget, navAction, navTarget, type NavTarget } from './sessionNav'
import { PersonaSelect } from './PersonaSelect'
import { LinearWorkspaceInput } from './LinearWorkspaceInput'
import { useSettings } from './useSettings'
import { useCommandPalette } from './useCommandPalette'
import { CommandPalette } from './CommandPalette'
import { RECORD_VERSION } from '../../shared/types.ts'

export interface StatusProps {
  onStatus: (updatedAt: Date | null, error: string | null) => void
}

/** 右ペイン（チャット）に渡すもの。「← 一覧」が広い画面ではサイドバーを開くだけなので、その口も渡す */
export interface PaneProps extends StatusProps {
  onOpenSidebar: () => void
  /** 入力欄が空のときの `←`。サイドバーの選ばれている項目にフォーカスを戻す（#204） */
  onLeaveToSidebar: () => void
  /** サーバ側の設定（一言が有効か、既定の性格）。まだ取れていなければ null */
  settings: SettingsResponse | null
  /** Linear の workspace（設定）。一言の中の PGR-123 のリンク先。空ならリンクにしない */
  linear: string
}

/** `→` / `←` の当て先が描画されるのを待つ上限。過ぎたら諦める */
const FOCUS_WAIT_MS = 2000

const DEFAULT_FILTERS: SessionFilters = { project: '', repo: '', agent: '', date: '', host: '', days: '7', archived: '' }

/** 画面の見た目の状態。フィルタと同じく localStorage に残す */
interface UiState {
  sidebar: 'open' | 'closed'
}
const DEFAULT_UI: UiState = { sidebar: 'open' }
/** ⌘K の候補がまだ何も無いとき（一覧の取得前）。毎回作り直すと再描画が増える */
const EMPTY_SESSIONS: never[] = []
const EMPTY_PROJECTS: never[] = []

/**
 * 1画面。左のサイドバーにセッション一覧、右にチャット（フィード or 選んだセッション）。
 * `#/` と `#/feed` は広い画面では同じ表示（サイドバー + フィード）。狭い画面では `#/` が一覧だけ、
 * `#/feed` / `#/todo` / `#/s/<id>` がチャットだけになる（CSS の main.route-* で切り替える）。
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
  // タブが裏にある間も間隔を空けて叩き続ける（#231）。待ちが増えたことを題名と通知で伝えるため。
  // チャットとフィードは見ていないので今までどおり止まる
  const list = usePolling(() => api.sessions(filters), [filters.project, filters.repo, filters.agent, filters.date, filters.days, filters.archived], { hiddenMs: HIDDEN_POLL_MS })

  // いま自分を待っているもの。サイドバーのバッジ・要対応の画面と同じ組み立てを使う（食い違わせない）。
  // replying も必ず渡す（渡し忘れると、題名と通知だけが処理中のセッションを数えてしまう。#232）
  const todo = useMemo(() => (list.data ? todoItems(list.data.sessions, list.data.approvals, list.data.host, list.data.replying) : null), [list.data])
  const notify = useNotify(todo)

  // サイドバーの開閉。レイアウトは main の class で CSS が切り替える。狭い画面では CSS 側が無視する
  const [ui, setUi] = useLocalState<UiState>('sai.ui', DEFAULT_UI)
  const sidebarOpen = ui.sidebar !== 'closed'
  const toggleSidebar = useCallback(() => setUi({ sidebar: sidebarOpen ? 'closed' : 'open' }), [setUi, sidebarOpen])
  const openSidebar = useCallback(() => setUi({ sidebar: 'open' }), [setUi])

  // 差分を出しているセッション。広い画面はチャットの右にペイン、狭い画面はモーダル（useNarrow）
  const [diffId, setDiffId] = useState<string | null>(null)
  const narrow = useNarrow()
  const closeDiff = useCallback(() => setDiffId(null), [])
  // 入力欄のボタンはトグル（開いていれば閉じる。#211）
  const toggleDiff = useCallback((id: string) => setDiffId((prev) => (prev === id ? null : id)), [])
  // 出すのは、いま開いているセッションの分だけ。別のセッションやフィードへ移っている間は出さない
  // （そのセッションに戻ってくれば、また出る。閉じるまでそのセッションのものとして覚えておく）
  const diffOpen = diffId !== null && route.name === 'session' && route.id === diffId ? diffId : null

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

  /**
   * キーボードで入力欄とサイドバーを行き来する（#204）。`→` で入力欄へ、空の入力欄で `←` で一覧へ。
   * 当て先はその場に居ないことがある（狭い画面では先に route を変える、閉じたサイドバーを開く、フィードの取得待ち）ので、
   * まずその場で当ててみて、無ければ描画のあとにもう一度探す。FOCUS_WAIT_MS を過ぎたら諦める（当て先が
   * 出てこないとき（アーカイブ済みで入力欄が無いなど）に、あとの描画で不意にフォーカスを奪わないため）
   */
  const focusLater = useRef<{ want: 'input' | 'sidebar'; at: number } | null>(null)
  const applyFocus = useCallback(() => {
    const pending = focusLater.current
    if (!pending) return
    const el =
      pending.want === 'input'
        ? document.querySelector<HTMLTextAreaElement>('.reply textarea')
        : // サイドバーの選ばれている項目。フィードは <a> そのもの、セッションは <div> の中の <a class="link">
          (() => {
            const item = document.querySelector<HTMLElement>('.channels .item.active')
            return item?.matches('a') ? item : (item?.querySelector<HTMLElement>('.link') ?? null)
          })()
    if (!el && Date.now() - pending.at < FOCUS_WAIT_MS) return // まだ描画されていない。次の描画で探し直す
    focusLater.current = null
    el?.focus()
  }, [])
  // 描画のあとに毎回。当て先が出てくるのを待つのはここだけで、state は増やさない
  useEffect(applyFocus)
  const focusSoon = useCallback(
    (want: 'input' | 'sidebar') => {
      focusLater.current = { want, at: Date.now() }
      applyFocus()
    },
    [applyFocus],
  )

  // ↑↓（j / k）でサイドバーの並びのまま隣へ（フィード → 要対応 → セッション）、Esc でフィードへ。起点は「いま開いているセッション」なので state は持たない。
  // 入力欄にフォーカスがあるときはそちらの操作（caret の移動、@ の候補）なので触らない。サイドバーを閉じていても効く
  // サイドバーで選ばれている項目。固定の「フィード」「要対応」もセッションと同じ 1 項目として扱う（#224）
  const active: NavTarget = route.name === 'session' ? { kind: 'session', id: route.id } : route.name === 'todo' ? { kind: 'todo' } : { kind: 'feed' }
  const sessionIds = useMemo(() => list.data?.sessions.map((s) => s.id) ?? [], [list.data])
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const action = navAction(e)
      if (!action || isTypingTarget(e.target as HTMLElement | null)) return
      if (action === 'input') {
        // 狭い画面の `#/` は一覧しか出ていない（.pane が display:none）ので、先にチャット側へ移る。
        // 入力欄が無いとき（アーカイブ済み、再開できないセッション）は、描画のあとの effect が何も見つけずに終わる
        e.preventDefault()
        if (narrow && parseRoute(location.hash).name === 'list') location.hash = '#/feed'
        focusSoon('input')
        return
      }
      if (action === 'feed' && diffOpen !== null) {
        // 差分を出しているときの Esc は、まずそれを閉じる
        e.preventDefault()
        setDiffId(null)
        return
      }
      if (action === 'feed') {
        const name = parseRoute(location.hash).name
        if (name !== 'session' && name !== 'todo') return
        e.preventDefault()
        location.hash = '#/feed'
        return
      }
      // 起点は「押した瞬間の URL」。state（selectedId）だと、連打したとき再描画が追いつかず
      // 同じ場所から2回動こうとして取りこぼす
      const at = parseRoute(location.hash)
      const from: NavTarget = at.name === 'session' ? { kind: 'session', id: at.id } : at.name === 'todo' ? { kind: 'todo' } : { kind: 'feed' }
      // 行き先はサイドバーの並びどおり（フィード → 要対応 → セッション）。端では何もしない。
      // preventDefault もしない（ページのスクロールに残す）
      const to = navTarget(sessionIds, from, action)
      if (to === null) return
      e.preventDefault()
      location.hash = to.kind === 'session' ? `#/s/${encodeURIComponent(to.id)}` : `#/${to.kind}`
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [sessionIds, diffOpen, narrow, focusSoon])

  // 待っている件数をタブの題名に出す（#231）。通知と違って許可が要らないので、切っていても出る
  useEffect(() => {
    document.title = titleWith(todo?.length ?? 0, route.name === 'session' ? route.id.slice(0, 12) : '')
  }, [route, todo])

  /** 入力欄で `←` を押されたとき。見えていない所には当てないので、閉じたサイドバーは開き、狭い画面は一覧側へ移る */
  const focusSidebar = useCallback(() => {
    openSidebar()
    if (narrow) location.hash = '#/'
    focusSoon('sidebar')
  }, [narrow, openSidebar, focusSoon])

  // 一言コメント（digest）の性格。サーバ側の設定なので取って来て、変えたら PUT。SAI_DIGEST=1 でないときは出さない
  const { settings, busy: settingsBusy, error: settingsError, setPersona, setLinearWorkspace } = useSettings()
  const linear = settings?.linear_workspace ?? ''

  // ⌘K でフィードとセッションを名前で探して移動する（#197）。開いたときに絞り込み無しで取り直す
  const palette = useCommandPalette()

  return (
    <>
      {palette.open && (
        <CommandPalette sessions={palette.all ?? list.data?.sessions ?? EMPTY_SESSIONS} loading={palette.all === null} onClose={palette.close} />
      )}
      <header>
        <button
          type="button"
          className="sidebar-toggle"
          onClick={toggleSidebar}
          aria-expanded={sidebarOpen}
          aria-keyshortcuts="Meta+\ Control+\"
          aria-label={sidebarOpen ? '一覧を隠す' : '一覧を出す'}
          title={`${sidebarOpen ? '一覧を隠す' : '一覧を出す'} (⌘\\ / Ctrl+\\)\nセッションの移動: ↑↓ または k / j、フィードへ戻る: Esc\n入力欄へ: →、空の入力欄から一覧へ: ←\n検索して移動: ⌘K / Ctrl+K`}
        >
          <MenuMark />
        </button>
        <div className="logo">
          SAI <small>agent-feed viewer</small>
        </div>
        {settings?.digest && (
          <div className="digest-ctl" title={settingsError || `一言コメント: ${settings.model}（${settings.provider}）`}>
            <PersonaSelect value={settings.persona} busy={settingsBusy} onChange={(p) => void setPersona(p)} />
            <LinearWorkspaceInput value={settings.linear_workspace} busy={settingsBusy} onChange={(ws) => void setLinearWorkspace(ws)} />
            {settingsError && <span className="note">{settingsError}</span>}
          </div>
        )}
        <div className={`status${status.error ? ' error' : ''}`}>
          {status.error ? `取得失敗: ${status.error}` : status.at ? `更新 ${hm(status.at.toISOString())}` : ''}
        </div>
        {/* 各エージェントの使用量。取れなければ何も出さない（3秒のポーリングには乗せない） */}
        <UsageChip />
        {import.meta.env.REPO_URL && (
          <a className="github" href={import.meta.env.REPO_URL} target="_blank" rel="noopener noreferrer" aria-label="GitHub リポジトリ" title="GitHub リポジトリ">
            <GitHubMark />
          </a>
        )}
        <UserMenu profile={list.data?.profile} viewer={list.data?.viewer ?? null} notify={notify} />
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
      <main className={`layout route-${route.name}${sidebarOpen ? '' : ' sidebar-closed'}${diffOpen !== null && !narrow ? ' diff-open' : ''}`}>
        <aside className="sidebar">
          {/* 幅を固定した箱に入れる。開閉の遷移中に列だけが縮み、中身は折り返さない */}
          <div className="side-inner">
            <SessionList list={list} filters={filters} setFilters={setFilters} active={active} />
          </div>
        </aside>
        <div className="pane">
          {route.name === 'todo' ? (
            <TodoView list={list} onStatus={onStatus} onOpenSidebar={openSidebar} onLeaveToSidebar={focusSidebar} linear={linear} settings={settings} />
          ) : route.name === 'session' ? (
            <SessionView id={route.id} focusTs={route.ts ?? ''} onStatus={onStatus} onOpenSidebar={openSidebar} onLeaveToSidebar={focusSidebar} onToggleDiff={toggleDiff} diffOpen={diffOpen !== null} linear={linear} settings={settings} />
          ) : (
            <FeedView
              project={filters.project}
              projects={list.data?.filters.projects ?? EMPTY_PROJECTS}
              onProject={(project) => setFilters({ project })}
              sessions={list.data?.sessions}
              selfHost={list.data?.host ?? ''}
              onStatus={onStatus}
              onOpenSidebar={openSidebar}
              onLeaveToSidebar={focusSidebar}
              linear={linear}
              settings={settings}
            />
          )}
        </div>
        {/* 広い画面はチャットの右にもう1枚。狭い画面は今までどおりモーダルで重ねる */}
        {diffOpen !== null && !narrow && <DiffPane id={diffOpen} onClose={closeDiff} />}
      </main>
      {diffOpen !== null && narrow && <DiffModal id={diffOpen} onClose={closeDiff} />}
    </>
  )
}

