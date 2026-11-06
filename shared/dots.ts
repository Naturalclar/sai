// dots との会話ログ（#872）。受信箱（`~/.agent-feed/dots-inbox.jsonl`）の行の形と、会話に組み立てる・依頼の状態を決める純粋関数。
// サーバ（`server/dots/inbox.ts`）と画面（`web/src/DotsView.tsx`）の両方が使う。
//
// - 受信箱を書くのは SAI のサーバと受信箱のアダプター（#873）だけ。行の記録（`record.py` の JSONL）とは混ぜない
// - いまは配信しない（#872）。届ける口と返答を受ける口は受信箱のアダプター（#873）で作る

/** 誰が書いたか。人が SAI の画面で書いた投稿か、dots の返答か */
export type DotsSource = 'sai-human' | 'dots'

/**
 * 依頼（人の投稿 1 つ）の状態。
 * `queued` 未配信 → `accepted` 受付済み → `awaiting` 返答待ち → `done` 完了。途中で `failed` 失敗・`unknown` 結果不明
 */
export const DOTS_STATES = ['queued', 'accepted', 'awaiting', 'done', 'failed', 'unknown'] as const
export type DotsState = (typeof DOTS_STATES)[number]

export function isDotsState(v: unknown): v is DotsState {
  return typeof v === 'string' && (DOTS_STATES as readonly string[]).includes(v)
}

/** 画面に出す言葉 */
export const DOTS_STATE_LABEL: Record<DotsState, string> = {
  queued: '未配信',
  accepted: '受付済み',
  awaiting: '返答待ち',
  done: '完了',
  failed: '失敗',
  unknown: '結果不明',
}

/**
 * 進んでよい先。`done` と `failed` は終わり（戻さない）。`unknown`（届いたか分からない）からは、分かった先へ進める。
 * 同じ状態への遷移は持たない（書いても何も変わらない）
 */
const NEXT: Record<DotsState, readonly DotsState[]> = {
  queued: ['accepted', 'failed', 'unknown'],
  accepted: ['awaiting', 'done', 'failed', 'unknown'],
  awaiting: ['done', 'failed', 'unknown'],
  unknown: ['accepted', 'awaiting', 'done', 'failed'],
  done: [],
  failed: [],
}

export function canMoveDots(from: DotsState, to: DotsState): boolean {
  return NEXT[from].includes(to)
}

/** 受信箱の 1 行: 投稿か返答 */
export interface DotsMessage {
  type: 'message'
  id: string
  conversation_id: string
  /** 人の投稿だけが持つ。依頼の鍵（アダプターが dots に渡し、返答の `reply_to` がこれを指す） */
  request_id?: string
  /** dots の返答だけが持つ。どの依頼への返答か（`request_id`） */
  reply_to?: string
  source: DotsSource
  /** ISO 8601 */
  at: string
  text: string
}

/** 受信箱の 1 行: 依頼の状態が変わった */
export interface DotsStateChange {
  type: 'state'
  request_id: string
  state: DotsState
  at: string
  /** 失敗・結果不明の理由（人に見せる短い文） */
  reason?: string
}

export type DotsLine = DotsMessage | DotsStateChange

/** 画面に出す依頼 1 つ: 人の投稿と、その下に付く返答 */
export interface DotsRequest {
  message: DotsMessage
  state: DotsState
  reason?: string
  replies: DotsMessage[]
}

export interface DotsConversation {
  id: string
  /** 会話の始まり（最初の投稿）と、最後に何かあった時刻 */
  started_at: string
  updated_at: string
  requests: DotsRequest[]
  /** どの依頼にも付けられない返答（`reply_to` の先がこの会話に無い）。捨てずに末尾に出す */
  orphans: DotsMessage[]
}

/** 本文の上限（字）。画面から書く投稿の長さ */
export const DOTS_TEXT_MAX = 20000

/** 受信箱の 1 行として読めるか。読めないものは null（壊れた行・知らない形は飛ばす） */
export function parseDotsLine(raw: unknown): DotsLine | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const r = raw as Record<string, unknown>
  const str = (v: unknown): v is string => typeof v === 'string' && v !== ''
  if (r.type === 'state') {
    if (!str(r.request_id) || !isDotsState(r.state) || !str(r.at)) return null
    return { type: 'state', request_id: r.request_id, state: r.state, at: r.at, ...(str(r.reason) ? { reason: r.reason } : {}) }
  }
  if (r.type !== 'message') return null
  if (!str(r.id) || !str(r.conversation_id) || !str(r.at) || typeof r.text !== 'string') return null
  if (r.source === 'sai-human') {
    if (!str(r.request_id)) return null
    return { type: 'message', id: r.id, conversation_id: r.conversation_id, request_id: r.request_id, source: 'sai-human', at: r.at, text: r.text }
  }
  if (r.source === 'dots') {
    if (!str(r.reply_to)) return null
    return { type: 'message', id: r.id, conversation_id: r.conversation_id, reply_to: r.reply_to, source: 'dots', at: r.at, text: r.text }
  }
  return null
}

const byAt = (a: { at: string }, b: { at: string }) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0)

/**
 * 受信箱の行を会話に組み立てる。会話は新しく動いた順、会話の中は時系列。
 *
 * - 返答は `reply_to` で依頼に付ける（書かれた順・時刻の順が入れ替わっても、付く先は変わらない）
 * - 状態は、その依頼の状態の行を時刻の順に `canMoveDots()` で当てていく（進めない遷移は捨てる）。行が無ければ `queued`
 * - 同じ `id` の行が 2 度あれば先のものだけ使う（書き直しで重ねない）
 */
export function dotsConversations(lines: readonly DotsLine[]): DotsConversation[] {
  const seen = new Set<string>()
  const messages: DotsMessage[] = []
  const changes: DotsStateChange[] = []
  for (const l of lines) {
    if (l.type === 'state') changes.push(l)
    else if (!seen.has(l.id)) {
      seen.add(l.id)
      messages.push(l)
    }
  }
  messages.sort(byAt)
  changes.sort(byAt)

  const convs = new Map<string, DotsConversation>()
  const requests = new Map<string, { conv: string; req: DotsRequest }>()
  for (const m of messages) {
    if (m.source !== 'sai-human' || !m.request_id || requests.has(m.request_id)) continue
    let c = convs.get(m.conversation_id)
    if (!c) {
      c = { id: m.conversation_id, started_at: m.at, updated_at: m.at, requests: [], orphans: [] }
      convs.set(c.id, c)
    }
    const req: DotsRequest = { message: m, state: 'queued', replies: [] }
    c.requests.push(req)
    if (m.at > c.updated_at) c.updated_at = m.at
    requests.set(m.request_id, { conv: c.id, req })
  }
  for (const m of messages) {
    if (m.source !== 'dots') continue
    const hit = m.reply_to ? requests.get(m.reply_to) : undefined
    // 別の会話の依頼を指す返答は付けない（会話を取り違えない）
    if (hit && hit.conv === m.conversation_id) hit.req.replies.push(m)
    else {
      let c = convs.get(m.conversation_id)
      if (!c) {
        c = { id: m.conversation_id, started_at: m.at, updated_at: m.at, requests: [], orphans: [] }
        convs.set(c.id, c)
      }
      c.orphans.push(m)
    }
    const c = convs.get(m.conversation_id)
    if (c && m.at > c.updated_at) c.updated_at = m.at
  }
  for (const ch of changes) {
    const hit = requests.get(ch.request_id)
    if (!hit || !canMoveDots(hit.req.state, ch.state)) continue
    hit.req.state = ch.state
    if (ch.reason) hit.req.reason = ch.reason
    else delete hit.req.reason
    const c = convs.get(hit.conv)
    if (c && ch.at > c.updated_at) c.updated_at = ch.at
  }
  return [...convs.values()].sort((a, b) => (a.updated_at < b.updated_at ? 1 : a.updated_at > b.updated_at ? -1 : 0))
}

/** `GET /api/dots` の応答 */
export interface DotsResponse {
  /** 受信箱が変わったか（ファイルの大きさと更新時刻）。同じなら画面は描き直さない */
  rev: string
  conversations: DotsConversation[]
}

/** `POST /api/dots` の body。`conversation_id` が無ければ新しい会話を始める */
export interface DotsPostRequest {
  text: string
  conversation_id?: string
}

export interface DotsPostResponse {
  ok: true
  message: DotsMessage
}
