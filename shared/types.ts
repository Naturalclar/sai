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
  /** そのターンの入力（人が打った文）。チャットで自分側のバブルになる。古い行には無い */
  user_text?: string
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
  /**
   * 一番新しい user_text の1行目（画面からの返信でも端末で打った指示でも、最後の入力に追従する）。
   * 無ければ first_user_text、それも無ければ最初の text の1行目。60文字で切る
   */
  title: string
  title_full: string
  /** 1行でも synth があれば synth */
  session_source: SessionSource
  sources: SessionSource[]
  last_text: string
}

/**
 * 返信（POST /api/sessions/<id>/reply）で回したターンが、まだ終わっていない。
 * 正本はサーバのメモリ（server/runner.ts）で、子プロセスが exit するまで残る。画面はこれを「送信中」の正とする
 */
export interface Replying {
  /** 起動した時刻 */
  since: string
  /** 送った文。リロードしても仮バブルに出せる */
  text: string
}

/** エンティティID → 処理中の返信。無ければ空 */
export type ReplyingMap = Record<string, Replying>

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
  /** 処理中の返信（窓の外のセッションも含む全部）。これが変わると rev も変わる */
  replying: ReplyingMap
}

export interface SessionDetailResponse {
  rev: string
  session: SessionSummary
  rows: FeedRow[]
  replying: ReplyingMap
}

export interface FeedResponse {
  rev: string
  days: number
  rows: FeedRow[]
  replying: ReplyingMap
}

/** POST /api/sessions/<id>/reply の body */
export interface ReplyRequest {
  text: string
}

/**
 * 202 で返す。ターンは裏で走るので、結果はそのセッションに増えた行で見る。
 * session は CLI に渡した生のセッションID（エンティティIDではない）
 */
export interface ReplyResponse {
  accepted: true
  id: string
  agent: Agent
  session: string
  cwd: string
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
