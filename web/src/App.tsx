import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react'
import { HIDDEN_POLL_MS, parseRoute, sessionHash, useHashRoute, useLocalState, usePolling, type Route } from './hooks'
import { closeColumn, EMPTY_LAYOUT, focusColumn, focusedItem, MAX_COLUMNS, nextUnshown, normalizeLayout, openBeside, openInNeighbor, placeItem, sessionIdsIn, type PaneItem, type PaneLayout } from './paneLayout'
import { paneKey } from './paneKeys'
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
  // ペインに出せるのはセッションと要対応。フィード・PR・新しいセッションは全幅で、戻れば並びも戻る
  const routeItem = useMemo<PaneItem | null>(() => (route.name === 'session' ? { kind: 'session', id: route.id } : route.name === 'todo' ? { kind: 'todo' } : null), [route])
  if (placed !== route) {
    setPlaced(route)
    if (routeItem) {
      const next = placeItem(layout, routeItem)
      if (next !== layout) setStoredPanes(next)
    }
  }
  // 「いま開いているもの」はフォーカスのあるペイン（題名・↑↓ の起点・差分ボタン）。並びを動かした直後の、
  // URL がまだ追いついていない 1 回の描画でも並びの方を見る
  const current = routeItem ? (focusedItem(layout) ?? routeItem) : null
  const currentId = current?.kind === 'session' ? current.id : ''
  // 並べて出すのは広い画面のときだけ。狭い画面（900px 以下）は今までどおりフォーカスのあるものだけ
  const split = routeItem !== null && !narrow && layout.columns.length > 1
  // 描くペイン。`key` は並びが持つ列の番号、`index` は列の位置（フォーカスを移す・閉じるときの名指し）
  const panes = useMemo(
    () =>
      split
        ? layout.columns.map((c, index) => ({ item: c[0]!, key: layout.keys[index] ?? index, index }))
        : current
          ? [{ item: current, key: layout.keys[layout.focus] ?? 0, index: layout.focus }]
          : [],
    [split, layout, current],
  )
  const paneIds = useMemo(() => panes.flatMap((p) => (p.item.kind === 'session' ? [p.item.id] : [])), [panes])
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
    diffOpen !== null && paneIds.includes(diffOpen) && diffSession !== undefined && !diffSession.archived && !replyBlockedReason(diffSession, list.data?.host ?? '')
  // PR の差分へのコメント（#525）を、その PR を書いたセッションの入力欄に入れてそのセッションへ移る（送るのは人）。
  // **打ちかけ（sai.drafts）の後ろに足してから移る**: 移った先の ReplyBox は作られたときに打ちかけを読むが、
  // 作られたときにもう来ている insert は「当てた」扱いにする（#511 は返信欄が開いたままなので当たっていた）
  const insertToSession = useCallback((id: string, text: string) => {
    const draft = loadDraft(id)
    saveDraft(id, { ...draft, text: appendInsert(draft.text, text) })
    location.hash = sessionHash(id)
  }, [])
  // 差分をモーダルにするかは画面全体の幅だけで決める（#647。900px 以下ならモーダル）。並べている数・サイドバーの開閉では
  // 変えない: 並べて見たいから並べているのに、差分を開くと全部が隠れるのを避ける。ペインが狭くなるのは受け入れる
  // 横に並べて開く（サイドバーの ⌘ + クリックと項目のボタン・`%`・⌘K の ⌘Enter）。フォーカスは開いた方へ移る。
  // `hash` は発言への飛び先まで付いているとき（⌘K の発言の当たり）
  const openBesideItem = useCallback(
    (item: PaneItem, hash?: string) => {
      setStoredPanes(openBeside(layout, item))
      if (hash) location.hash = hash
      else goTo(item)
    },
    [layout, setStoredPanes],
  )
  // 要対応から、もうペインに出ているセッションの入力欄へ文を戻す（送れなかった返信）。出ている入力欄は打ちかけを
  // 読み直さないので、差分のコメントと同じ口（`insert`）で後ろに足す（#643 のレビュー）
  const insertToShown = useCallback((id: string, text: string) => setCommentInsert((prev) => ({ id, text, seq: (prev?.seq ?? 0) + 1 })), [])
  const openBesideHash = useCallback(
    (hash: string) => {
      const to = parseRoute(hash)
      if (to.name === 'session') openBesideItem({ kind: 'session', id: to.id }, hash)
    },
    [openBesideItem],
  )
  // 要対応のペインの中の、セッションへ飛ぶリンク（#633）。**要対応は残して、隣のペインに開く**。
  // 修飾キー付き（新しいタブなど）はブラウザに残す。`index` は押された要対応のペインの列
  const openFromTodo = useCallback(
    (e: ReactMouseEvent<HTMLDivElement>, index: number) => {
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return
      const hash = e.target instanceof Element ? e.target.closest('a[href^="#/s/"]')?.getAttribute('href') : null
      const to = hash ? parseRoute(hash) : null
      if (!hash || to?.name !== 'session') return
      e.preventDefault()
      setStoredPanes(openInNeighbor({ ...layout, focus: index }, { kind: 'session', id: to.id }))
      location.hash = hash
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
      if (narrow) setDiff(null)
    },
    [diffOpen, narrow],
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

  // ペインをキーボードで分ける・移る・閉じる（#633。判定は paneKeys.ts）。`%` `h` `l` `x` は入力欄で打っている間は効かず、
  // `Ctrl+1〜3` だけは入力中でも効く（そのペインの入力欄へ）。狭い画面・モーダルを出している間・全幅の画面では何もしない
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const key = paneKey(e, isTypingTarget(e.target as HTMLElement | null))
      if (!key || narrow || !routeItem || document.querySelector('.modal-backdrop')) return
      if (key.kind === 'split') {
        // 新しいペインには、サイドバーの並びで次の、まだ出していないセッションが入る。上限・出すものが無ければ何もしない
        const id = layout.columns.length < MAX_COLUMNS ? nextUnshown(sessionIds, sessionIdsIn(layout), currentId) : null
        if (id === null) return
        e.preventDefault()
        openBesideItem({ kind: 'session', id })
        return
      }
      if (key.kind === 'focus') {
        if (key.index >= panes.length) return
        e.preventDefault()
        if (panes[key.index]!.index === layout.focus) {
          focusSoon('input')
          return
        }
        // 当て先（.pane.focused）は描き直したあとに変わるので、その場では当てず描画のあとの effect に任せる。
        // blur より先に頼んでおく（blur がその場で描き直しを起こし、そのあとでは次の描画が来ないことがある）
        focusLater.current = { want: 'input', at: Date.now() }
        focusPane(key.index)
        // 移った先に入力欄が無い（要対応・アーカイブ済み）とき、キャレットを前のペインの入力欄に残さない
        // （残すと、フォーカスの印は移ったのに打った字と ⌘Enter は前のペインに行く。#643 のレビュー）
        if (document.activeElement instanceof HTMLElement && document.activeElement.closest('.pane')) document.activeElement.blur()
        return
      }
      if (!split) return
      if (key.kind === 'close') {
        e.preventDefault()
        closePane(layout.focus)
        return
      }
      const to = layout.focus + key.by
      if (to < 0 || to >= layout.columns.length) return
      e.preventDefault()
      focusPane(to)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [narrow, routeItem, layout, sessionIds, currentId, panes, split, openBesideItem, focusPane, closePane, focusSoon])

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
        <CommandPalette sessions={palette.all ?? list.data?.sessions ?? EMPTY_SESSIONS} loading={palette.all === null} onClose={palette.close} onOpenBeside={narrow ? undefined : openBesideHash} />
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
      <main className={`layout route-${route.name}${sidebarOpen ? '' : ' sidebar-closed'}${diffOpen !== null && !narrow ? ' diff-open' : ''}`}>
        <aside className="sidebar">
          {/* 幅を固定した箱に入れる。開閉の遷移中に列だけが縮み、中身は折り返さない */}
          <div className="side-inner">
            <SessionList list={list} filters={filters} setFilters={setFilters} active={active} creating={route.name === 'new'} groups={groups} collapsed={groupUi.collapsed} onToggleGroup={toggleGroup} prs={sessionPrs} shown={split ? paneIds : EMPTY_SESSIONS} todoShown={split && panes.some((p) => p.item.kind === 'todo')} onOpenBeside={narrow ? undefined : openBesideItem} />
          </div>
        </aside>
        <div className={`panes${split ? ' split' : ''}`}>
          {routeItem ? (
            // 並べているときは列の数だけ（#633）。key は並びが持つ列の番号（`PaneLayout.keys`）: 中身を入れ替えても同じ
            // SessionView が id だけ変わり（1 つのときの今までの動き）、左を閉じた・間に足したときも残ったペインは作り直さない
            panes.map(({ item, key, index }) => {
              const here = item === current
              const id = item.kind === 'session' ? item.id : ''
              const onRoute = route.name === 'session' && route.id === id
              return (
                <ChatPane
                  key={`pane:${key}`}
                  focused={here}
                  onFocusPane={split ? () => focusPane(index) : undefined}
                  onClose={split ? () => closePane(index) : undefined}
                  // 要対応の行からセッションへ飛ぶリンクは隣のペインに開く（狭い画面は今までどおり移るだけ）
                  onClickCapture={item.kind === 'todo' && !narrow ? (e) => openFromTodo(e, index) : undefined}
                >
                  {item.kind === 'todo' ? (
                    <TodoView list={list} onStatus={here ? onStatus : NO_STATUS} onOpenSidebar={openSidebar} onLeaveToSidebar={focusSidebar} linear={linear} settings={settings} prs={sessionPrs} focused={here} shown={paneIds} onInsertToShown={insertToShown} />
                  ) : (
                    <SessionView
                      id={id}
                      // 発言への飛び先（ts）は URL が指しているペインだけ
                      focusTs={onRoute ? (route.ts ?? '') : ''}
                      {...(onRoute && route.side ? { focusSide: route.side } : {})}
                      onStatus={here ? onStatus : NO_STATUS}
                      onOpenSidebar={openSidebar}
                      onLeaveToSidebar={focusSidebar}
                      onToggleDiff={toggleDiff}
                      diffOpen={diffOpen === id}
                      focused={here}
                      {...(commentInsert && commentInsert.id === id ? { insert: commentInsert } : {})}
                      linear={linear}
                      settings={settings}
                      peers={list.data?.sessions}
                    />
                  )}
                </ChatPane>
              )
            })
          ) : (
            <ChatPane focused>
            {route.name === 'prs' ? (
              <PrListView onStatus={onStatus} onOpenSidebar={openSidebar} />
            ) : route.name === 'pr' ? (
              <PrView key={`${route.repo}#${route.number}`} repo={route.repo} number={route.number} onStatus={onStatus} onInsertToSession={insertToSession} />
            ) : route.name === 'new' ? (
              <NewSessionView replying={list.data?.replying} now={list.updatedAt?.getTime() ?? 0} onOpenSidebar={openSidebar} />
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
        {diffOpen !== null && !narrow && <DiffPane id={diffOpen} onClose={closeDiff} canReview={canReview} {...(canComment ? { onInsertComments: insertComments } : {})} />}
      </main>
      {diffOpen !== null && narrow && <DiffModal id={diffOpen} onClose={closeDiff} canReview={canReview} {...(canComment ? { onInsertComments: insertComments } : {})} />}
    </>
  )
}

