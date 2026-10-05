// serve 側の実装は server/。型は shared/types.ts に1つだけ置いて両方から import する
import type {
  ApprovalAnswer,
  AttachmentResponse,
  FeedFilters,
  FeedResponse,
  NewSessionRequest,
  WorkspacesResponse,
  NewSessionResponse,
  Profile,
  ProfileResponse,
  ReplyError,
  ReplyRequest,
  ReplyResponse,
  ReviewRequest,
  ReviewResponse,
  ReviewTarget,
  SessionDetailResponse,
  SessionDiffResponse,
  SearchResponse,
  SessionDiffSummaryResponse,
  GalleryResponse,
  SessionTurnResponse,
  TurnStepsResponse,
  SessionFilters,
  SessionIconResponse,
  IconHistoryResponse,
  SessionMeta,
  SessionMetaResponse,
  ReadRequest,
  ReadResponse,
  SuggestionActionRequest,
  SuggestionActionResponse,
  SessionPermissionsResponse,
  SessionProgressResponse,
  SessionModelsResponse,
  SessionSkillsResponse,
  SessionsResponse,
  SettingsRequest,
  SettingsResponse,
  ReplyQueueResponse,
  LoopRequest,
  LoopResponse,
  AgentStopResponse,
  UsageResponse,
  PrsResponse,
  UsageReportResponse,
  PrDetailResponse,
  SessionFileResponse,
  PrReviewRequest,
  PrReviewResponse,
} from '../../shared/types.ts'
import { fetchByRev, RevCache } from './revCache.ts'
import { sessionFileUrl } from '../../shared/files.ts'
import type { DigestFeedbackReason, DigestFeedbackRequest, DigestFeedbackResponse, DigestUsageReason } from '../../shared/digestFeedback.ts'

export type { Agent, FeedRow, TurnStepsResponse, SessionSource, SessionSummary, SessionMeta, ManagerDraft, SessionsResponse, Facets, SessionFilters, FeedFilters, Replying, ReplyingMap, QueuedReply, ReplyQueue, ReplyQueueMap, ReplyQueueResponse, Loop, LoopMap, LoopRequest, AgentActivity, AgentActivityMessage, AgentStopResponse,Approval, ApprovalMap, ApprovalAnswer, TerminalDialog, Profile, PersonaId, SettingsResponse, SettingsRequest, Viewer, SessionPermissionsResponse, SessionProgressResponse, ProgressStep, ProgressNote, SessionDiffResponse, SessionDiffSummaryResponse, GalleryResponse, GalleryItem, SearchResponse, SearchHit, DiffPr, DiffSection, DiffFileStat, PrSummary, PrRepo, PrsResponse, PrDetailResponse, PrComment, PrReviewRequest, PrReviewResponse, PrReviewEvent, AttachmentResponse, UsageResponse, UsageReportResponse, UsageReportRow, UsageSessionRow, UsageTotals, UsageWindow, CodexUsage, ClaudeUsage } from '../../shared/types.ts'

/**
 * `PUT /api/sessions/<id>/meta` のボディ。`SessionMeta` の一部を重ねる。
 * **消すときは `null`（か空文字）を送る**（サーバの `mergeMeta()` が「falsy なら消す」。省略は据え置き）ので、
 * 値の型そのままだと消せない（`digest_off?: true` に `null` を入れられない）
 */
export type MetaPatch = { [K in keyof SessionMeta]?: SessionMeta[K] | null }

/** サーバの失敗。`code` / `typed` は返信の 409（ReplyError）から。画面はこれで「消して送る」の確認を出し分ける */
export class ApiError extends Error {
  readonly status: number
  readonly code?: ReplyError['code']
  readonly typed?: string
  /** 端末に打てない 409 で、via: process なら別プロセスで送れる */
  readonly canProcess: boolean
  constructor(message: string, status: number, code?: ReplyError['code'], typed?: string, canProcess = false) {
    super(message)
    this.status = status
    this.code = code
    this.typed = typed
    this.canProcess = canProcess
  }
}

/** サーバは失敗を { error } で返す。それがあればそのまま見せる */
async function failure(res: Response, url: string): Promise<Error> {
  try {
    const body = (await res.json()) as Partial<ReplyError>
    if (typeof body.error === 'string' && body.error) {
      return new ApiError(body.error, res.status, body.code, typeof body.typed === 'string' ? body.typed : undefined, body.can_process === true)
    }
  } catch {
    // JSON でない
  }
  return new ApiError(`${res.status} ${url}`, res.status)
}

/** いま開いている画面が、どのビルド（サーバの X-SAI-Build）から来たか */
let knownBuild: string | null = null

/**
 * 別ターミナルで pnpm build されて dist/ が入れ替わったら、画面を丸ごと読み直す。
 * 3秒ポーリングのついでにヘッダを見るだけなので追加のリクエストは無い。
 * pnpm dev（Vite）中は HMR に任せるので何もしない。
 */
function watchBuild(res: Response): void {
  if (!import.meta.env.PROD) return
  const build = res.headers.get('x-sai-build')
  if (!build) return
  if (knownBuild !== null && knownBuild !== build) {
    location.reload()
    return
  }
  knownBuild = build
}

async function getJSON<T>(url: string): Promise<T> {
  const res = await fetch(url, { cache: 'no-store' })
  if (!res.ok) throw await failure(res, url)
  watchBuild(res)
  return (await res.json()) as T
}

/** 一覧・詳細・フィード（rev を持つ応答）。変わっていなければサーバは 304 で本文を送らない（#592。`revCache.ts`） */
const revCache = new RevCache()
async function getRevJSON<T>(url: string): Promise<T> {
  const { res, data } = await fetchByRev(revCache, url, (u, init) => fetch(u, init))
  if (data === undefined) throw await failure(res, url)
  watchBuild(res)
  return data as T
}

async function sendJSON<T>(method: 'POST' | 'PUT', url: string, body: object): Promise<T> {
  const res = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  if (!res.ok) throw await failure(res, url)
  return (await res.json()) as T
}

/** 画像などをそのまま送る（PUT）か、消す（DELETE） */
async function sendRaw<T>(method: 'POST' | 'PUT' | 'DELETE', url: string, body?: Blob): Promise<T> {
  const res = await fetch(url, { method, body })
  if (!res.ok) throw await failure(res, url)
  return (await res.json()) as T
}

/** アイコンの履歴（#465）を誰のために開くか。セッションか自分か */
export type IconTarget = { kind: 'session'; id: string } | { kind: 'profile' }

/**
 * クエリ文字列。配列は同じ名前を繰り返す。`projects` だけはサーバの受け口の名前 `project` に直す
 * （#529。`?project=a&project=b`。1 つだけ送っていた前の形とそのまま互換）
 */
const qs = (params: object) => {
  const out = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    const name = key === 'projects' ? 'project' : key
    if (Array.isArray(value)) for (const v of value) out.append(name, String(v))
    else out.append(name, String(value))
  }
  return out.toString()
}

export const api = {
  sessions: (f: SessionFilters) => getRevJSON<SessionsResponse>(`/api/sessions?${qs(f)}`),
  /** `recent` を付けると直近その日数の行だけ（#477）。`focus`（検索の飛び先）はそこまで必ず含める */
  session: (id: string, { recent, focus = '' }: { recent?: number; focus?: string } = {}, days = 90) =>
    getRevJSON<SessionDetailResponse>(
      `/api/sessions/${encodeURIComponent(id)}?days=${days}${recent ? `&recent=${recent}` : ''}${focus ? `&focus=${encodeURIComponent(focus)}` : ''}`,
    ),
  feed: (f: FeedFilters) => getRevJSON<FeedResponse>(`/api/feed?${qs(f)}`),
  /** 返信。replaceTyped は端末の打ちかけを消して打ち込んでよい（409 の code: terminal_typed を人が確認したあと） */
  reply: (id: string, text: string, options: { replaceTyped?: boolean; via?: 'process'; attachments?: string[]; queue?: boolean; steer?: boolean; compact?: boolean } = {}, days = 90) =>
    sendJSON<ReplyResponse>(
      'POST',
      `/api/sessions/${encodeURIComponent(id)}/reply?days=${days}`,
      {
        text,
        ...(options.replaceTyped ? { replace_typed: true } : {}),
        ...(options.via ? { via: options.via } : {}),
        ...(options.attachments?.length ? { attachments: options.attachments } : {}),
        // 処理中なら預かってもらう（#305。サーバは処理中でなければそのまま起動する）
        ...(options.queue ? { queue: true } : {}),
        // 走っているターンに足す（#404。足せなければサーバが預かりに落とす）
        ...(options.steer ? { steer: true } : {}),
        // 要約してから送る（#579。当たらなければサーバがそのまま送る）
        ...(options.compact ? { compact: true } : {}),
      } satisfies ReplyRequest,
    ),
  /** 新しいセッションを始める（#314）。worktree は既存のセッション（from）で指し、パスは送らない */
  startSession: (body: NewSessionRequest, days = 90) => sendJSON<NewSessionResponse>('POST', `/api/sessions/new?days=${days}`, body),
  /** 新しいセッションを始められる場所（#319。git の作業ツリーの中の記録と、同じリポジトリの兄弟 worktree）。画面を開いたときだけ */
  workspaces: (days = 90) => getJSON<WorkspacesResponse>(`/api/workspaces?days=${days}`),
  /** 預けた返信を取り消す（#305。まだ回していないものだけ） */
  cancelQueued: (id: string, queueId: string) =>
    sendRaw<ReplyQueueResponse>('DELETE', `/api/sessions/${encodeURIComponent(id)}/queue/${encodeURIComponent(queueId)}`),
  /** 止めた預かり（前の返信が失敗した・起動できなかった）を再開する */
  resumeQueue: (id: string) => sendJSON<ReplyQueueResponse>('POST', `/api/sessions/${encodeURIComponent(id)}/queue/resume`, {}),
  /**
   * 処理中のターンを止める（#384）。止められるのは SAI が起こした Codex / OpenCode / Claude のターンだけ（`Replying.interruptible`）。
   * 返るのは止めたあとの預かり（勝手に回さないよう止めてあるので、`paused` が入っている）
   */
  interrupt: (id: string) => sendJSON<ReplyQueueResponse>('POST', `/api/sessions/${encodeURIComponent(id)}/interrupt`, {}),
  /** そのセッションが別のセッションへ送るのを止める（#311）。預かりに並んでいたそのセッションからの分も取り消す */
  stopAgent: (id: string) => sendJSON<AgentStopResponse>('POST', `/api/sessions/${encodeURIComponent(id)}/agent/stop`, {}),
  /** 止めた送信を再開する */
  resumeAgent: (id: string) => sendJSON<AgentStopResponse>('POST', `/api/sessions/${encodeURIComponent(id)}/agent/resume`, {}),
  /** ループを組む（#634）。目的と終わりの条件は必須で、上限は省略すると既定値 */
  startLoop: (id: string, body: LoopRequest) => sendJSON<LoopResponse>('POST', `/api/sessions/${encodeURIComponent(id)}/loop`, body),
  /** ループを止める・再開する・いま起こす。止めても回っている周のターンは止まらない */
  loopAction: (id: string, action: 'stop' | 'resume' | 'wake') => sendJSON<LoopResponse>('POST', `/api/sessions/${encodeURIComponent(id)}/loop/${action}`, {}),
  /** 終わったループを片付ける */
  clearLoop: (id: string) => sendRaw<LoopResponse>('DELETE', `/api/sessions/${encodeURIComponent(id)}/loop`),
  meta: (id: string) => getJSON<SessionMetaResponse>(`/api/sessions/${encodeURIComponent(id)}/meta`),
  /** `/` の候補になるスキル。入力欄で `/` を打った時に 1 回だけ取る */
  sessionSkills: (id: string) => getJSON<SessionSkillsResponse>(`/api/sessions/${encodeURIComponent(id)}/skills`),
  sessionModels: (id: string) => getJSON<SessionModelsResponse>(`/api/sessions/${encodeURIComponent(id)}/models`),
  /**
   * 一言が変だと伝える（#346）。~/.agent-feed/digest-feedback.jsonl に溜めるだけで、その場の一言は変わらない。
   * 一言そのものはサーバが鍵から引くので送らない
   */
  digestFeedback: (key: string, reason: DigestFeedbackReason | DigestUsageReason, note?: string) =>
    sendJSON<DigestFeedbackResponse>('POST', '/api/digest/feedback', { key, reason, ...(note ? { note } : {}) } satisfies DigestFeedbackRequest),
  /** 発言の本文を検索する（#230）。⌘K で打ち終わったときだけ叩く（ポーリングには乗せない） */
  search: (q: string, days = 90) => getJSON<SearchResponse>(`/api/search?q=${encodeURIComponent(q)}&days=${days}`),
  /** そのセッションの worktree の差分（開いたときだけ。ポーリングには乗せない） */
  /** 差分のレビューを Codex に頼む（#403）。対象の種類だけ送る（cwd もブランチ名もサーバが決める） */
  review: (id: string, target: ReviewTarget, days = 90) =>
    sendJSON<ReviewResponse>('POST', `/api/sessions/${encodeURIComponent(id)}/review?days=${days}`, { target } satisfies ReviewRequest),

  diff: (id: string, base = '') =>
    getJSON<SessionDiffResponse>(`/api/sessions/${encodeURIComponent(id)}/diff${base ? `?base=${encodeURIComponent(base)}` : ''}`),
  /** 差分の大きさと PR 番号だけ（本文は作らない）。入力欄のボタンが開く前に出す（#211） */
  diffSummary: (id: string) => getJSON<SessionDiffSummaryResponse>(`/api/sessions/${encodeURIComponent(id)}/diff?summary=1`),
  /** そのセッションに出てきた画像（#504）。開いたときと新しいターンが記録されたときだけ取る */
  /** 返答に出てきたファイル（#603）。URL に載せるのは鍵だけ。読めなければサーバの理由つきで投げる */
  sessionFile: (id: string, path: string) => getJSON<SessionFileResponse>(sessionFileUrl(id, path)),
  gallery: (id: string) => getJSON<GalleryResponse>(`/api/sessions/${encodeURIComponent(id)}/gallery`),
  /** 一言のもとになったターン完了の行（#537）。要対応の「終了」の行で「元の文」を押したときだけ */
  /** 終わったターンで呼んだツール（#605）。開いたときに 1 回だけ */
  turnSteps: (id: string, ts: string) => getJSON<TurnStepsResponse>(`/api/sessions/${encodeURIComponent(id)}/turn-steps?ts=${encodeURIComponent(ts)}`),
  turn: (id: string, ts: string) => getJSON<SessionTurnResponse>(`/api/sessions/${encodeURIComponent(id)}/turn?ts=${encodeURIComponent(ts)}`),
  /** 処理中のターンがいま何をしているか（#302）。処理中のセッションを出している間だけ取る（一覧のポーリングには乗せない） */
  progress: (id: string) => getJSON<SessionProgressResponse>(`/api/sessions/${encodeURIComponent(id)}/progress`),
  /** そのセッションの cwd に効いている許可ルール。画面が開いたときだけ取る（ポーリングには乗せない） */
  permissions: (id: string, days = 90) =>
    getJSON<SessionPermissionsResponse>(`/api/sessions/${encodeURIComponent(id)}/permissions?days=${days}`),
  /** 返信中の許可・質問に答える。allow は updatedInput を省けば元の入力のまま */
  answerApproval: (approvalId: string, answer: ApprovalAnswer) =>
    sendJSON<{ ok: true }>('POST', `/api/approvals/${encodeURIComponent(approvalId)}/answer`, answer),
  /** 表示名をいまの値に重ねる。空文字は「消す」 */
  /** 未読の印を置く（#502）。`back` は「ここから未読にする」 */
  markRead: (id: string, body: ReadRequest) =>
    sendJSON<ReadResponse>('PUT', `/api/sessions/${encodeURIComponent(id)}/read`, body),
  /** Manager が置いた案（#565）を捨てる・入力欄に入れた。どちらも案を取り除くだけで送らない */
  suggestionAction: (id: string, body: SuggestionActionRequest) =>
    sendJSON<SuggestionActionResponse>('POST', `/api/sessions/${encodeURIComponent(id)}/suggestion`, body),
  setMeta: (id: string, meta: MetaPatch, days = 90) =>
    sendJSON<SessionMetaResponse>('PUT', `/api/sessions/${encodeURIComponent(id)}/meta?days=${days}`, meta),
  /** アイコン画像を置く。返ってくる icon が新しい URL */
  /** 返信に添える画像を預ける。返った path を reply の attachments に入れる */
  addAttachment: (id: string, file: Blob, name = '', days = 90) =>
    sendRaw<AttachmentResponse>('POST', `/api/sessions/${encodeURIComponent(id)}/attachments?days=${days}${name ? `&name=${encodeURIComponent(name)}` : ''}`, file),
  setIcon: (id: string, file: Blob, days = 90) =>
    sendRaw<SessionIconResponse>('PUT', `/api/sessions/${encodeURIComponent(id)}/icon?days=${days}`, file),
  clearIcon: (id: string) => sendRaw<SessionIconResponse>('DELETE', `/api/sessions/${encodeURIComponent(id)}/icon`),
  /**
   * 今まで使ったアイコン画像（#465）。`id` / `profile` を渡すと、いまのアイコンと同じ画像の鍵が `current` に載る。
   * 開いたときだけ取る（ポーリングには乗せない）
   */
  iconHistory: (target: IconTarget) =>
    getJSON<IconHistoryResponse>(`/api/icon-history?${target.kind === 'profile' ? 'profile=1' : `id=${encodeURIComponent(target.id)}`}`),
  /** 履歴の画像をそのまま付ける。body は送らない（サーバが自分の置き場から読む） */
  setIconFromHistory: (id: string, key: string, days = 90) =>
    sendRaw<SessionIconResponse>('PUT', `/api/sessions/${encodeURIComponent(id)}/icon?days=${days}&history=${encodeURIComponent(key)}`),
  setProfileIconFromHistory: (key: string) => sendRaw<ProfileResponse>('PUT', `/api/profile/icon?history=${encodeURIComponent(key)}`),
  /** 履歴から消す。いま使っているアイコンは消えない */
  removeIconHistory: (key: string) => sendRaw<IconHistoryResponse>('DELETE', `/api/icon-history/${encodeURIComponent(key)}`),
  /** 自分の表示名とアイコン。一覧・詳細・フィードにも profile として載るので、普段はそちらを見る */
  profile: () => getJSON<ProfileResponse>('/api/profile'),
  /** 表示名を置く。空文字は「消す」 */
  setProfile: (profile: Pick<Profile, 'name'>) => sendJSON<ProfileResponse>('PUT', '/api/profile', profile),
  setProfileIcon: (file: Blob) => sendRaw<ProfileResponse>('PUT', '/api/profile/icon', file),
  clearProfileIcon: () => sendRaw<ProfileResponse>('DELETE', '/api/profile/icon'),
  /** 各エージェントの使用量。ローカルのファイルから読むだけ（ポーリングには乗せない） */
  usage: () => getJSON<UsageResponse>('/api/usage'),
  /** 使用量の画面の集計（#602）。SAI が起こした Claude のターンだけ。開いたときと期間を切り替えたときだけ取る */
  usageReport: (days: number) => getJSON<UsageReportResponse>(`/api/usage/report?days=${days}`),
  /** GitHub に出ている PR（#524）。`fresh` のときだけサーバの覚えを捨てて gh で読み直す */
  prs: (fresh = false) => getJSON<PrsResponse>(`/api/prs${fresh ? '?fresh=1' : ''}`),
  pr: (repo: string, number: number) => getJSON<PrDetailResponse>(`/api/prs/${repo.split('/').map(encodeURIComponent).join('/')}/${number}`),
  /** GitHub にレビューを投稿する（#526）。SAI が GitHub に書く唯一の口 */
  postPrReview: (repo: string, number: number, body: PrReviewRequest) =>
    sendJSON<PrReviewResponse>('POST', `/api/prs/${repo.split('/').map(encodeURIComponent).join('/')}/${number}/review`, body),
  /** サーバ側の設定（一言の性格。digest が有効か） */
  settings: () => getJSON<SettingsResponse>('/api/settings'),
  setSettings: (body: SettingsRequest) => sendJSON<SettingsResponse>('PUT', '/api/settings', body),
}

