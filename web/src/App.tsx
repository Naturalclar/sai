import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { HIDDEN_POLL_MS, parseRoute, sessionHash, useHashRoute, useLocalState, useMediaQuery, usePolling, type Route } from './hooks'
import { closeColumn, diffModalBelow, EMPTY_LAYOUT, focusColumn, focusedItem, normalizeLayout, openBeside, placeItem, sessionIdsIn, type PaneItem, type PaneLayout } from './paneLayout'
import { ChatPane } from './ChatPane'
import { pendingItems, todoItems } from '../../shared/todoItems.ts'
import { sessionGroups, toggleCollapsed, visibleIds } from './sessionGroups'
import { titleWith } from '../../shared/notify.ts'
import { replyBlockedReason } from '../../shared/reply.ts'
import { useNotify } from './useNotify'
import { SessionList } from './SessionList'
import { SessionView } from './SessionView'
import { DiffPane } from './DiffPane'
import { DiffModal } from './DiffModal'
import { useNarrow } from './useNarrow'
import { nextDiff, visibleDiff, type DiffOrigin, type OpenDiff } from './feedDiff.ts'
import { FeedView } from './FeedView'
import { TodoView } from './TodoView'
import { NewSessionView } from './NewSessionView'
import { PrListView } from './PrListView'
import { PrView } from './PrView'
import { loadDraft, saveDraft } from './replyDrafts'
import { appendInsert } from './replyRestore'
import { hm } from './format'
import { MenuMark } from './MenuMark'
import { GitHubMark } from './GitHubMark'
import { UserMenu } from './UserMenu'
import { UsageChip } from './UsageChip'
import { api, type SessionFilters, type SettingsResponse } from './api'
import { isTypingTarget, navAction, navTarget, type NavTarget } from './sessionNav'
import { DigestControls } from './DigestControls'
import { DigestEngineControls } from './DigestEngineControls'
import { JevControls } from './JevControls'
import { useSettings } from './useSettings'
import { useCommandPalette } from './useCommandPalette'
import { CommandPalette } from './CommandPalette'
import { RECORD_VERSION } from '../../shared/types.ts'
import { storedProjects } from '../../shared/projectFilter.ts'
import { useSessionPrs } from './useSessionPrs'

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

/** サイドバーで選ばれている項目。固定の「フィード」「要対応」「PR」もセッションと同じ 1 項目として扱う（PR 1 本は「PR」の下） */
function navOf(route: Route): NavTarget {
  if (route.name === 'session') return { kind: 'session', id: route.id }
  if (route.name === 'todo') return { kind: 'todo' }
  if (route.name === 'prs' || route.name === 'pr') return { kind: 'prs' }
  return { kind: 'feed' }
}

/** `→` / `←` の当て先が描画されるのを待つ上限。過ぎたら諦める */
const FOCUS_WAIT_MS = 2000

/**
 * localStorage（`sai.filters`）に置く形。リポジトリは `projects`（#529）だが、それより前は `project`（1 つの文字列）で
 * 持っていたので両方を読む（`storedProjects()`）。既定に `projects` を入れないのは、入れると古い `project` より
 * 空の配列が先に見つかって、選んでいたリポジトリが「すべて」に戻るため
 */
type StoredFilters = Omit<SessionFilters, 'projects'> & { projects?: string[]; project?: string }
const DEFAULT_FILTERS: StoredFilters = { repo: '', agent: '', date: '', host: '', days: '7', archived: '' }

/** 画面の見た目の状態。フィルタと同じく localStorage に残す */
interface UiState {
  sidebar: 'open' | 'closed'
}
const DEFAULT_UI: UiState = { sidebar: 'open' }
/**
 * サイドバーで畳んでいるリポジトリの塊（#364）。**覚えるのは畳んだものだけ**で、既定は全部開いた状態
 * （新しいリポジトリのセッションが増えても勝手に畳まれない）
 */
interface GroupState {
  collapsed: string[]
}
const DEFAULT_GROUPS: GroupState = { collapsed: [] }
/** ⌘K の候補がまだ何も無いとき（一覧の取得前）。毎回作り直すと再描画が増える */
const EMPTY_SESSIONS: never[] = []
const EMPTY_PROJECTS: never[] = []
/** フォーカスの無いペインの取得状況はヘッダに出さない（#633。「更新 hh:mm」はフォーカスのあるペインの分だけ） */
const NO_STATUS: StatusProps['onStatus'] = () => {}
/** サイドバーの幅（styles.css の `main.layout` の 1 列目と同じ値） */
const SIDEBAR_PX = 320

/** フォーカスを移した・ペインを閉じたあと、URL をフォーカスのあるペインに合わせる */
function goTo(item: PaneItem | null) {
  if (item?.kind === 'session') location.hash = sessionHash(item.id)
  else if (item?.kind === 'todo') location.hash = '#/todo'
}

/**
 * 1画面。左のサイドバーにセッション一覧、右にチャット（フィード or 選んだセッション）。
 * `#/` と `#/feed` は広い画面では同じ表示（サイドバー + フィード）。狭い画面では `#/` が一覧だけ、
 * `#/feed` / `#/todo` / `#/s/<id>` がチャットだけになる（CSS の main.route-* で切り替える）。
 */
export function App() {
  const route = useHashRoute()
  const narrow = useNarrow()

  // チャットの領域を左右に分ける並び（#633）。localStorage に持ち、**URL はフォーカスのあるペインの 1 つを指す**。
  // URL が変わったら（クリック・↑↓・戻る）並びに反映する: もう並んでいればそのペインへフォーカスを移し、
  // 無ければフォーカスのあるペインの中身を入れ替える。route が変わったときだけ合わせる（描画中に導く。
  // 毎回合わせると、ペインを閉じた直後のまだ古い URL で、閉じたものを並びに戻してしまう）
  const [storedPanes, setStoredPanes] = useLocalState<PaneLayout>('sai.panes', EMPTY_LAYOUT)
  const layout = useMemo(() => normalizeLayout(storedPanes), [storedPanes])
  const [placed, setPlaced] = useState<Route | null>(null)
  if (placed !== route) {
    setPlaced(route)
    if (route.name === 'session') {
      const next = placeItem(layout, { kind: 'session', id: route.id })
      if (next !== layout) setStoredPanes(next)
    }
  }
  // 並べて出すのは、セッションを開いていて広い画面のときだけ。フィード・要対応・PR・新しいセッションは全幅で、
  // セッションに戻れば並びも戻る。狭い画面（900px 以下）は今までどおり 1 つ
  const focused = focusedItem(layout)
  // 「いま開いているセッション」はフォーカスのあるペイン（題名・↑↓ の起点・差分ボタン）。並びを動かした直後の、
  // URL がまだ追いついていない 1 回の描画でも並びの方を見る
  const currentId = route.name !== 'session' ? '' : focused?.kind === 'session' ? focused.id : route.id
  const layoutIds = useMemo(() => sessionIdsIn(layout), [layout])
  const split = route.name === 'session' && !narrow && layoutIds.length > 1
  const paneIds = useMemo(() => (split ? layoutIds : currentId ? [currentId] : []), [split, layoutIds, currentId])
  // ヘッダの「更新 hh:mm」は右側（チャット）の分だけ。サイドバーは自分の失敗を自分の中に出す
  const [status, setStatus] = useState<{ at: Date | null; error: string | null }>({ at: null, error: null })
  // 子の useEffect の依存に入るので、毎回作り直すと無限に再描画する
  const onStatus = useCallback<StatusProps['onStatus']>((at, error) => setStatus({ at, error }), [])

  // 絞り込みはサイドバーのもの。フィードのリポジトリはこれに従う（同じ画面に「リポジトリ」を2つ出さない）
  const [stored, setStored] = useLocalState<StoredFilters>('sai.filters', DEFAULT_FILTERS)
  const filters: SessionFilters = useMemo(() => {
    const { project: _old, ...rest } = stored
    return { ...rest, projects: storedProjects(stored) }
  }, [stored])
  // 書くときは新しい形だけにする（古い `project` は undefined にして JSON から落とす）
  const setFilters = useCallback((next: Partial<SessionFilters>) => setStored({ ...next, ...(next.projects ? { project: undefined } : {}) }), [setStored])
  const projectsKey = filters.projects.join('\n')
  // 一覧はここで1回だけ取り、サイドバー（表示）とフィード（@ の候補）の両方に渡す。同じ URL を2回叩かない
  // タブが裏にある間も間隔を空けて叩き続ける（#231）。待ちが増えたことを題名と通知で伝えるため。
  // チャットとフィードは見ていないので今までどおり止まる
  const list = usePolling(() => api.sessions(filters), [projectsKey, filters.repo, filters.agent, filters.date, filters.host, filters.days, filters.archived], { hiddenMs: HIDDEN_POLL_MS })
  // サイドバーのセッションに付ける PR（#548）。一覧のポーリングとは別に 60 秒おき
  const sessionPrs = useSessionPrs()

  // いま自分を待っているもの。サイドバーのバッジ・要対応の画面と同じ組み立てを使う（食い違わせない）。
  // replying も必ず渡す（渡し忘れると、題名と通知だけが処理中のセッションを数えてしまう。#232）
  const todo = useMemo(() => (list.data ? todoItems(list.data.sessions, list.data.approvals, list.data.host, list.data.replying, list.data.loops) : null), [list.data])
  const notify = useNotify(todo)

  // サイドバーの開閉。レイアウトは main の class で CSS が切り替える。狭い画面では CSS 側が無視する
  const [groupUi, setGroupUi] = useLocalState<GroupState>('sai.groups', DEFAULT_GROUPS)
  const [ui, setUi] = useLocalState<UiState>('sai.ui', DEFAULT_UI)
  const sidebarOpen = ui.sidebar !== 'closed'
  const toggleSidebar = useCallback(() => setUi({ sidebar: sidebarOpen ? 'closed' : 'open' }), [setUi, sidebarOpen])
  const openSidebar = useCallback(() => setUi({ sidebar: 'open' }), [setUi])

  // 差分を出しているセッションと、どこから開いたか。広い画面はチャットの右にペイン、狭い画面はモーダル（useNarrow）
  const [diff, setDiff] = useState<OpenDiff | null>(null)
  const closeDiff = useCallback(() => setDiff(null), [])
  // 差分へのコメント（#511）を返信欄に入れる頼み。入れる先はそのセッションの画面の返信欄だけ（フィードは返信先が @ で動く）
  const [commentInsert, setCommentInsert] = useState<{ id: string; text: string; seq: number } | null>(null)
  // 出すのは、いま開いているセッションの分と、フィードのバブルから開いたものはフィードにいる間（#280）。
  // 別のセッションへ移っている間は出さない（戻ってくれば、また出る。閉じるまで覚えておく）。規則は feedDiff.ts
  const diffOpen = visibleDiff(diff, route, narrow, paneIds)
  // ボタンはトグル（出ていれば閉じる。#211）。「いま出ているか」で決めるので、セッションで開いたまま
  // フィードに来て同じセッションのバブルを押しても、閉じずに開く
  const toggleDiff = useCallback((id: string, origin: DiffOrigin = 'session') => setDiff(nextDiff(diffOpen, id, origin)), [diffOpen])
  const toggleFeedDiff = useCallback((id: string) => toggleDiff(id, 'feed'), [toggleDiff])
  // 差分ビューアの「レビューさせる」は Codex だけ（#403）。返信できないセッション（別のマシン・合成 ID）にも出さない
  const diffSession = diffOpen === null ? undefined : list.data?.sessions.find((s) => s.id === diffOpen)
  const canReview = Boolean(diffSession?.agent === 'codex' && !replyBlockedReason(diffSession, list.data?.host ?? ''))
  // 行へのコメントは、そのセッションを開いていて返信欄が出ているときだけ（入れる先がある）。
  // 条件は SessionView が返信欄を出す条件と同じ（アーカイブ済みは返信欄の代わりに案内が出る。#512 のレビュー）
  const canComment =
    diffOpen !== null && route.name === 'session' && paneIds.includes(diffOpen) && diffSession !== undefined && !diffSession.archived && !replyBlockedReason(diffSession, list.data?.host ?? '')
  // PR の差分へのコメント（#525）を、その PR を書いたセッションの入力欄に入れてそのセッションへ移る（送るのは人）。
  // **打ちかけ（sai.drafts）の後ろに足してから移る**: 移った先の ReplyBox は作られたときに打ちかけを読むが、
  // 作られたときにもう来ている insert は「当てた」扱いにする（#511 は返信欄が開いたままなので当たっていた）
  const insertToSession = useCallback((id: string, text: string) => {
    const draft = loadDraft(id)
    saveDraft(id, { ...draft, text: appendInsert(draft.text, text) })
    location.hash = sessionHash(id)
  }, [])
  // 並べているとき、差分を足すと 1 ペインが狭くなりすぎる幅ではモーダルに落とす（#633。1 つのときは今までどおり）
  const tight = useMediaQuery(`(max-width: ${diffModalBelow(paneIds.length, sidebarOpen ? SIDEBAR_PX : 0)}px)`)
  const diffModal = narrow || (split && tight)
  // 横に並べて開く（サイドバーの ⌘ + クリックと項目のボタン）。フォーカスは開いた方へ移る
  const openBesideSession = useCallback(
    (id: string) => {
      setStoredPanes(openBeside(layout, { kind: 'session', id }))
      location.hash = sessionHash(id)
    },
    [layout, setStoredPanes],
  )
  const focusPane = useCallback(
    (index: number) => {
      const next = focusColumn(layout, index)
      if (next === layout) return
      setStoredPanes(next)
      goTo(focusedItem(next))
    },
    [layout, setStoredPanes],
  )
  // ペインを閉じる。そのセッションの差分を出していれば差分も閉じる（覚えたままにすると、また並べたとき不意に出る）
  const closePane = useCallback(
    (index: number) => {
      const next = closeColumn(layout, index)
      if (next === layout) return
      const closed = layout.columns[index]?.[0]
      if (closed?.kind === 'session' && diff?.id === closed.id) setDiff(null)
      setStoredPanes(next)
      goTo(focusedItem(next))
    },
    [layout, setStoredPanes, diff],
  )
  const insertComments = useCallback(
    (text: string) => {
      if (diffOpen === null) return
      setCommentInsert((prev) => ({ id: diffOpen, text, seq: (prev?.seq ?? 0) + 1 }))
      // モーダルは返信欄を隠しているので閉じる（右のペインで出しているときは残したまま、横の返信欄に入る）
      if (diffModal) setDiff(null)
    },
    [diffOpen, diffModal],
  )

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
        ? // 並べているときはフォーカスのあるペインの入力欄（#633）
          document.querySelector<HTMLTextAreaElement>('.pane.focused .reply textarea')
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
  const active = navOf(route)
  // リポジトリごとの塊（#364）。**画面の並びとキーボードの ↑↓ の並びは同じ関数から作る**ので、
  // 畳んだ塊の中のセッション（見えていない）には移らない
  // サイドバーの塊の見出しに出す「要対応」の数。**`done`（終わって次を待っているだけ）は数えない**（#438）。
  // バッジ・タブの題名と同じ `pendingItems()` を通すので、3 か所が食い違わない
  const waitingIds = useMemo(() => new Set(pendingItems(todo ?? []).map((t) => t.id)), [todo])
  const groups = useMemo(() => sessionGroups(list.data?.sessions ?? [], waitingIds), [list.data, waitingIds])
  const toggleGroup = useCallback((key: string) => setGroupUi({ collapsed: toggleCollapsed(groupUi.collapsed, key) }), [setGroupUi, groupUi.collapsed])
  const sessionIds = useMemo(() => visibleIds(groups, groupUi.collapsed), [groups, groupUi.collapsed])
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
        setDiff(null)
        return
      }
      if (action === 'feed') {
        const name = parseRoute(location.hash).name
        if (name !== 'session' && name !== 'todo' && name !== 'new' && name !== 'prs' && name !== 'pr') return
        e.preventDefault()
        location.hash = '#/feed'
        return
      }
      // 起点は「押した瞬間の URL」。state（selectedId）だと、連打したとき再描画が追いつかず
      // 同じ場所から2回動こうとして取りこぼす
      const from = navOf(parseRoute(location.hash))
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
    document.title = titleWith(pendingItems(todo ?? []).length, currentId.slice(0, 12))
  }, [currentId, todo])

  /** 入力欄で `←` を押されたとき。見えていない所には当てないので、閉じたサイドバーは開き、狭い画面は一覧側へ移る */
  const focusSidebar = useCallback(() => {
    openSidebar()
    if (narrow) location.hash = '#/'
    focusSoon('sidebar')
  }, [narrow, openSidebar, focusSoon])

  // 一言コメント（digest）の設定。サーバ側の設定なので取って来て、変えたら PUT。入切・口・モデルは自分のメニューにいつも出し（#288）、
  // 性格と Linear の workspace は一言を作っているときだけ出す
  const { settings, busy: settingsBusy, error: settingsError, update: updateSettings, refresh: refreshSettings, setPersona, setLinearWorkspace } = useSettings()
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
        {/* 狭い画面では 2 行目に落ちてどの画面でも場所を取るので、自分のメニューの中に入れる（#274） */}
        {settings?.digest && !narrow && (
          <DigestControls settings={settings} busy={settingsBusy} error={settingsError} onPersona={(p) => void setPersona(p)} onLinearWorkspace={(ws) => void setLinearWorkspace(ws)} />
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
        <UserMenu profile={list.data?.profile} viewer={list.data?.viewer ?? null} notify={notify} onOpen={refreshSettings}>
          {/* 一言の入切・口・モデルはどの幅でもここ（#288。前は環境変数）。PUT の失敗もここに出す */}
          {settings && <DigestEngineControls settings={settings} busy={settingsBusy} error={settingsError} onChange={(p) => void updateSettings(p)} />}
          {/* 許可の確率を Jev に聞くか（#491。既定は入。鍵が無ければ送らない） */}
          {settings && <JevControls settings={settings} busy={settingsBusy} onChange={(p) => void updateSettings(p)} />}
          {settings?.digest && narrow && (
            <DigestControls settings={settings} busy={settingsBusy} error="" onPersona={(p) => void setPersona(p)} onLinearWorkspace={(ws) => void setLinearWorkspace(ws)} />
          )}
        </UserMenu>
      </header>
      {/* 記録側の record.py が古い（フックが古い checkout や試作を呼んでいる）。窓の中の一番新しい行の v で見る */}
      {list.data && list.data.record_version > 0 && list.data.record_version < RECORD_VERSION && (
        <div className="banner" role="status">
          記録側の <code>record.py</code> が古い（v{list.data.record_version}、最新は v{RECORD_VERSION}）。フックの向け先を確かめてください（README「1. フックを向ける」）
        </div>
      )}
      {/* 記録に届いていないフック（#567）。行からは分からない（SessionEnd は /clear・/exit でしか書かれない）ので設定を読んで出す。
          古いサーバ（立て直す前）は載せてこないので無い扱い */}
      {list.data && (list.data.hooks_missing ?? []).length > 0 && (
        <div className="banner" role="status">
          フックが繋がっていません: <code>{list.data.hooks_missing.join('、')}</code>（README「1. フックを向ける」。<code>/setup-sai</code> で足せます）
        </div>
      )}
      {/* 配っている web/dist/ がソースより古い（git pull のあと pnpm build していない）。pnpm dev は HMR で常に最新なので出さない */}
      {import.meta.env.PROD && list.data?.build_stale && (
        <div className="banner" role="status">
          画面のビルドが古い。別のターミナルで <code>pnpm build</code> してください（終わると自動で読み直す）
        </div>
      )}
      <main className={`layout route-${route.name}${sidebarOpen ? '' : ' sidebar-closed'}${diffOpen !== null && !diffModal ? ' diff-open' : ''}`}>
        <aside className="sidebar">
          {/* 幅を固定した箱に入れる。開閉の遷移中に列だけが縮み、中身は折り返さない */}
          <div className="side-inner">
            <SessionList list={list} filters={filters} setFilters={setFilters} active={active} creating={route.name === 'new'} groups={groups} collapsed={groupUi.collapsed} onToggleGroup={toggleGroup} prs={sessionPrs} shown={split ? paneIds : EMPTY_SESSIONS} onOpenBeside={narrow ? undefined : openBesideSession} />
          </div>
        </aside>
        <div className={`panes${split ? ' split' : ''}`}>
          {route.name === 'session' ? (
            // 並べているときは列の数だけ（#633）。key は並びが持つ列の番号（`PaneLayout.keys`）: 中身を入れ替えても同じ
            // SessionView が id だけ変わり（1 つのときの今までの動き）、左を閉じた・間に足したときも残ったペインは作り直さない
            paneIds.map((id, i) => (
              <ChatPane key={`pane:${split ? layout.keys[i] : layout.keys[layout.focus] ?? 0}`} focused={id === currentId} onFocusPane={split ? () => focusPane(i) : undefined} onClose={split ? () => closePane(i) : undefined}>
                <SessionView
                  id={id}
                  // 発言への飛び先（ts）は URL が指しているペインだけ
                  focusTs={id === route.id ? (route.ts ?? '') : ''}
                  {...(id === route.id && route.side ? { focusSide: route.side } : {})}
                  onStatus={id === currentId ? onStatus : NO_STATUS}
                  onOpenSidebar={openSidebar}
                  onLeaveToSidebar={focusSidebar}
                  onToggleDiff={toggleDiff}
                  diffOpen={diffOpen === id}
                  focused={id === currentId}
                  {...(commentInsert && commentInsert.id === id ? { insert: commentInsert } : {})}
                  linear={linear}
                  settings={settings}
                  peers={list.data?.sessions}
                />
              </ChatPane>
            ))
          ) : (
            <ChatPane focused>
            {route.name === 'prs' ? (
              <PrListView onStatus={onStatus} onOpenSidebar={openSidebar} />
            ) : route.name === 'pr' ? (
              <PrView key={`${route.repo}#${route.number}`} repo={route.repo} number={route.number} onStatus={onStatus} onInsertToSession={insertToSession} />
            ) : route.name === 'new' ? (
              <NewSessionView replying={list.data?.replying} now={list.updatedAt?.getTime() ?? 0} onOpenSidebar={openSidebar} />
            ) : route.name === 'todo' ? (
              <TodoView list={list} onStatus={onStatus} onOpenSidebar={openSidebar} onLeaveToSidebar={focusSidebar} linear={linear} settings={settings} prs={sessionPrs} />
            ) : (
              <FeedView
                selected={filters.projects}
                projects={list.data?.filters.projects ?? EMPTY_PROJECTS}
                onProjects={(projects) => setFilters({ projects })}
                sessions={list.data?.sessions}
                selfHost={list.data?.host ?? ''}
                openDiff={diffOpen}
                onToggleDiff={toggleFeedDiff}
                onStatus={onStatus}
                onOpenSidebar={openSidebar}
                onLeaveToSidebar={focusSidebar}
                linear={linear}
                settings={settings}
                prs={sessionPrs}
              />
            )}
            </ChatPane>
          )}
        </div>
        {/* 広い画面はチャットの右にもう1枚。狭い画面は今までどおりモーダルで重ねる */}
        {diffOpen !== null && !diffModal && <DiffPane id={diffOpen} onClose={closeDiff} canReview={canReview} {...(canComment ? { onInsertComments: insertComments } : {})} />}
      </main>
      {diffOpen !== null && diffModal && <DiffModal id={diffOpen} onClose={closeDiff} canReview={canReview} {...(canComment ? { onInsertComments: insertComments } : {})} />}
    </>
  )
}

