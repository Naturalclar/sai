// serve 側の実装は server/。型は shared/types.ts に1つだけ置いて両方から import する
import type {
  ApprovalAnswer,
  AttachmentResponse,
  FeedFilters,
  FeedResponse,
  Profile,
  ProfileResponse,
  ReplyError,
  ReplyRequest,
  ReplyResponse,
  SessionDetailResponse,
  SessionDiffResponse,
  SessionDiffSummaryResponse,
  SessionFilters,
  SessionIconResponse,
  SessionMeta,
  SessionMetaResponse,
  SessionPermissionsResponse,
  SessionSkillsResponse,
  SessionsResponse,
  SettingsRequest,
  SettingsResponse,
  UsageResponse,
} from '../../shared/types.ts'

export type { Agent, FeedRow, SessionSource, SessionSummary, SessionMeta, SessionsResponse, Facets, SessionFilters, FeedFilters, Replying, ReplyingMap, Approval, ApprovalMap, ApprovalAnswer, Profile, PersonaId, SettingsResponse, SettingsRequest, Viewer, SessionPermissionsResponse, SessionDiffResponse, SessionDiffSummaryResponse, DiffPr, DiffSection, DiffFileStat, AttachmentResponse, UsageResponse, UsageWindow, CodexUsage, ClaudeUsage } from '../../shared/types.ts'

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

const qs = (params: object) => new URLSearchParams(Object.entries(params)).toString()

export const api = {
  sessions: (f: SessionFilters) => getJSON<SessionsResponse>(`/api/sessions?${qs(f)}`),
  session: (id: string, days = 90) =>
    getJSON<SessionDetailResponse>(`/api/sessions/${encodeURIComponent(id)}?days=${days}`),
  feed: (f: FeedFilters) => getJSON<FeedResponse>(`/api/feed?${qs(f)}`),
  /** 返信。replaceTyped は端末の打ちかけを消して打ち込んでよい（409 の code: terminal_typed を人が確認したあと） */
  reply: (id: string, text: string, options: { replaceTyped?: boolean; via?: 'process'; attachments?: string[] } = {}, days = 90) =>
    sendJSON<ReplyResponse>(
      'POST',
      `/api/sessions/${encodeURIComponent(id)}/reply?days=${days}`,
      {
        text,
        ...(options.replaceTyped ? { replace_typed: true } : {}),
        ...(options.via ? { via: options.via } : {}),
        ...(options.attachments?.length ? { attachments: options.attachments } : {}),
      } satisfies ReplyRequest,
    ),
  meta: (id: string) => getJSON<SessionMetaResponse>(`/api/sessions/${encodeURIComponent(id)}/meta`),
  /** `/` の候補になるスキル。入力欄で `/` を打った時に 1 回だけ取る */
  sessionSkills: (id: string) => getJSON<SessionSkillsResponse>(`/api/sessions/${encodeURIComponent(id)}/skills`),
  /** そのセッションの worktree の差分（開いたときだけ。ポーリングには乗せない） */
  diff: (id: string, base = '') =>
    getJSON<SessionDiffResponse>(`/api/sessions/${encodeURIComponent(id)}/diff${base ? `?base=${encodeURIComponent(base)}` : ''}`),
  /** 差分の大きさと PR 番号だけ（本文は作らない）。入力欄のボタンが開く前に出す（#211） */
  diffSummary: (id: string) => getJSON<SessionDiffSummaryResponse>(`/api/sessions/${encodeURIComponent(id)}/diff?summary=1`),
  /** そのセッションの cwd に効いている許可ルール。画面が開いたときだけ取る（ポーリングには乗せない） */
  permissions: (id: string, days = 90) =>
    getJSON<SessionPermissionsResponse>(`/api/sessions/${encodeURIComponent(id)}/permissions?days=${days}`),
  /** 返信中の許可・質問に答える。allow は updatedInput を省けば元の入力のまま */
  answerApproval: (approvalId: string, answer: ApprovalAnswer) =>
    sendJSON<{ ok: true }>('POST', `/api/approvals/${encodeURIComponent(approvalId)}/answer`, answer),
  /** 表示名をいまの値に重ねる。空文字は「消す」 */
  setMeta: (id: string, meta: SessionMeta, days = 90) =>
    sendJSON<SessionMetaResponse>('PUT', `/api/sessions/${encodeURIComponent(id)}/meta?days=${days}`, meta),
  /** アイコン画像を置く。返ってくる icon が新しい URL */
  /** 返信に添える画像を預ける。返った path を reply の attachments に入れる */
  addAttachment: (id: string, file: Blob, days = 90) =>
    sendRaw<AttachmentResponse>('POST', `/api/sessions/${encodeURIComponent(id)}/attachments?days=${days}`, file),
  setIcon: (id: string, file: Blob, days = 90) =>
    sendRaw<SessionIconResponse>('PUT', `/api/sessions/${encodeURIComponent(id)}/icon?days=${days}`, file),
  clearIcon: (id: string) => sendRaw<SessionIconResponse>('DELETE', `/api/sessions/${encodeURIComponent(id)}/icon`),
  /** 自分の表示名とアイコン。一覧・詳細・フィードにも profile として載るので、普段はそちらを見る */
  profile: () => getJSON<ProfileResponse>('/api/profile'),
  /** 表示名を置く。空文字は「消す」 */
  setProfile: (profile: Pick<Profile, 'name'>) => sendJSON<ProfileResponse>('PUT', '/api/profile', profile),
  setProfileIcon: (file: Blob) => sendRaw<ProfileResponse>('PUT', '/api/profile/icon', file),
  clearProfileIcon: () => sendRaw<ProfileResponse>('DELETE', '/api/profile/icon'),
  /** 各エージェントの使用量。ローカルのファイルから読むだけ（ポーリングには乗せない） */
  usage: () => getJSON<UsageResponse>('/api/usage'),
  /** サーバ側の設定（一言の性格。digest が有効か） */
  settings: () => getJSON<SettingsResponse>('/api/settings'),
  setSettings: (body: SettingsRequest) => sendJSON<SettingsResponse>('PUT', '/api/settings', body),
}

