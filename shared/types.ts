// agent-feed の1行と、SAI の API の形。サーバ（server/）と画面（web/src/）が両方ここを import する。
// フィールドを足すときはここに足す。JSONL の形は feed/record.py が正本。

export type Agent = 'claude' | 'codex' | 'unknown'
export type SessionSource = 'payload' | 'rollout' | 'synth' | ''

/** ~/.agent-feed/YYYY-MM-DD.jsonl の1行 = 1ターン */
export interface FeedRow {
  ts: string
  agent: Agent
  repo: string
  branch: string
  session: string
  session_source: SessionSource
  cwd: string
  event: string
  text: string
  first_user_text?: string
}

/** 行をセッション単位にまとめたもの。GET /api/sessions の1件 */
export interface SessionSummary {
  id: string
  start: string
  end: string
  /** 最初の行の日付（Asia/Tokyo） */
  date: string
  dates: string[]
  agent: Agent
  agents: Agent[]
  /** 途中で変わったら最後の値。全部は repos に */
  repo: string
  repos: string[]
  branch: string
  branches: string[]
  cwd: string
  turns: number
  /** first_user_text があればそれ、無ければ最初の text の1行目。60文字で切る */
  title: string
  title_full: string
  /** 1行でも synth があれば synth */
  session_source: SessionSource
  sources: SessionSource[]
  last_text: string
}

export interface Facets {
  repos: string[]
  agents: Agent[]
  dates: string[]
}

export interface SessionsResponse {
  rev: string
  days: number
  /** 絞り込み前の件数 */
  total: number
  sessions: SessionSummary[]
  /** 絞り込み前の全体から作った候補 */
  filters: Facets
}

export interface SessionDetailResponse {
  rev: string
  session: SessionSummary
  rows: FeedRow[]
}

export interface FeedResponse {
  rev: string
  days: number
  rows: FeedRow[]
}

export interface SessionFilters {
  repo: string
  agent: string
  date: string
  days: string
}

export interface FeedFilters {
  repo: string
  days: string
}
