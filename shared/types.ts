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
  /**
   * 何の行か。Claude はフック名（`Stop` / `PermissionRequest` / `PreToolUse` / `Notification` / `UserPromptSubmit`）、
   * Codex は `agent-turn-complete`。読み方は shared/events.ts の eventKind()
   */
  event: 'Stop' | 'PermissionRequest' | 'PreToolUse' | 'Notification' | 'UserPromptSubmit' | 'agent-turn-complete' | (string & {})
  /** ターン完了の行は最後のアシスタント発話。待ちの行は「何を待っているか」（`許可待ち: Bash: rm -rf node_modules` など） */
  text: string
  /** そのターンの入力（人が打った文）。チャットで自分側 のバブルになる。古い行には無い */
  user_text?: string
  /**
   * そのターンの思考（Claude の thinking ブロック / Codex の reasoning summary）。ターン完了の行だけで、
   * 無いことが多い（transcript に残るのは短い要約で、ターンの 4 分の 1 程度）。セッション画面のバブルに
   * 折りたたんで出す。GET /api/feed の行からは落とす（フィードには出さないので運ばない）
   */
  thinking?: string
  first_user_text?: string
  /**
   * text をチャットの一言コメントに言い換えたもの（性格つき）。JSONL には無く、サーバが応答時に
   * ~/.agent-feed/digest.jsonl から載せる（server/digest.ts）。無ければ省略で、画面は text を出す
   */
  summary?: string
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
  /** ターン完了の行の数（待ちや再開の行は数えない） */
  turns: number
  /**
   * 人を待って止まっている。最後の行が待ちの行ならその text、ターン完了か再開が後に来ていれば空。
   * 一覧の「待機中」の印と、チャット見出しに出す
   */
  waiting: string
  /**
   * 一番新しい user_text の1行目（画面からの返信でも端末で打った指示でも、最後の入力に追従する）。
   * 無ければ first_user_text、それも無ければ最初の text の1行目。60文字で切る
   */
  title: string
  title_full: string
  /** 1行でも synth があれば synth */
  session_source: SessionSource
  sources: SessionSource[]
  /** 最後のターン完了の text の1行目（待ちの行は見ない） */
  last_text: string
  /** 最後のターン完了の行の ts（一言を引くキー）。ターン完了が無ければ空。集計が付けるので、手で組む fixture では省略可 */
  last_turn_ts?: string
  /** last_text の一言版（digest）。無ければ省略で、画面は last_text を出す */
  last_summary?: string
  /** ブラウザから付けた表示名・アーカイブ。無ければ undefined（title を使う） */
  meta?: SessionMeta
  /**
   * ブラウザから置いたアイコン画像の URL（`/api/sessions/<id>/icon?v=<mtime>`）。無ければ省略。
   * 画像は ~/.agent-feed/session-icons/ にあり、サーバが応答時にファイルの有無を見て載せる
   */
  icon?: string
  /**
   * アーカイブ済みか。サーバが応答時に `meta.archived_at >= end` で決める（アーカイブ後に行が増えると
   * end が追い越すので、メタを書き換えずに自動で戻る）。一覧・フィードの既定では出ない。false なら省略
   */
  archived?: boolean
}

/** セッションに人が付けるもの。~/.agent-feed/session-meta.json に JSONL とは別で持つ（アイコン画像はファイルで別、SessionSummary.icon） */
export interface SessionMeta {
  /** 表示名。一覧とチャット見出しで title の代わりに出し、チャットのバブルの発言者名にもなる */
  name?: string
  /** アーカイブした時刻（ISO）。これより新しい行が届いていなければアーカイブ済み */
  archived_at?: string
}

/**
 * GET/PUT /api/sessions/<id>/meta。PUT の body は SessionMeta の一部で、いまの値に重ねる:
 * 省略したキーは据え置き、空文字や null は「消す」。名前を付けるだけ・アーカイブを切り替えるだけ、が互いを消さない
 */
export interface SessionMetaResponse {
  id: string
  meta: SessionMeta
}

/**
 * PUT/DELETE /api/sessions/<id>/icon。PUT の body は画像そのもの（PNG / JPEG / GIF / WebP、1MB まで）。
 * icon は置いた画像の URL（SessionSummary.icon と同じ形）、消したら null
 */
export interface SessionIconResponse {
  id: string
  icon: string | null
}

/**
 * 自分（人）の表示名とアイコン。SAI は1人のローカルの道具なので1つだけ。
 * 表示名は ~/.agent-feed/profile.json、アイコンは session-icons/ に固定の鍵（shared/profile.ts の PROFILE_ICON_ID）で置く。
 * チャットの自分側のバブルの名前とアバターになる（無ければ「あなた」/「私」）
 */
export interface Profile {
  name?: string
  /** アイコン画像の URL（/api/profile/icon?v=<mtime>）。無ければ undefined */
  icon?: string
}

/** GET/PUT /api/profile、PUT/DELETE /api/profile/icon の応答 */
export interface ProfileResponse {
  profile: Profile
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

/**
 * 返信中のエージェントが人の答えを待っている（ツール実行の許可、AskUserQuestion）。
 * `claude -p` の `--permission-prompt-tool` が SAI の MCP ツール（server/approve-mcp.ts）を呼び、
 * それが SAI サーバに預けたもの。画面の [許可] [拒否] で答えるまでエージェントは止まっている。
 * 正本はサーバのメモリ（server/approvals.ts）で、返信のプロセスが exit したら消える
 */
export interface Approval {
  approval_id: string
  /** どのエンティティ（返信先）か */
  id: string
  since: string
  tool_name: string
  /** ツールに渡そうとしている入力そのもの（Bash なら { command, description }） */
  input: Record<string, unknown>
  tool_use_id: string
  /** 何を聞かれているか（`許可待ち: Bash: rm -rf node_modules` / `質問: どのフレームワーク?`）。shared/approvals.ts */
  text: string
}

/** エンティティID → 答え待ちの承認（古い順）。無ければ空 */
export type ApprovalMap = Record<string, Approval[]>

/** POST /api/approvals の body。MCP ツール（server/approve-mcp.ts）が送る */
export interface ApprovalRequest {
  id: string
  tool_name: string
  input: Record<string, unknown>
  tool_use_id?: string
}

/**
 * POST /api/approvals/<approval_id>/answer の body と、MCP ツールが CLI に返す決定。
 * allow のとき updatedInput を省けば元の input のまま。AskUserQuestion は answers を足した input を返す
 */
export interface ApprovalAnswer {
  behavior: 'allow' | 'deny'
  updatedInput?: Record<string, unknown>
  /** deny の理由。エージェントに見える */
  message?: string
  /**
   * 画面 → サーバ。「常に許可」。サーバがルールを組み立てて updatedPermissions に変える（画面はルールを送らない）。
   * `local` = 返信の cwd の .claude/settings.local.json に書く（端末の「今後も許可」と同じ。新しいプロセスでも聞かれない）
   */
  remember?: 'local'
  /** サーバ → CLI。許可のルールを覚えさせる。CLI（--permission-prompt-tool）が自分で設定に書く */
  updatedPermissions?: PermissionUpdate[]
}

/** Claude Code に覚えさせる許可のルール（SDK の PermissionUpdate のうち SAI が使う形） */
export interface PermissionUpdate {
  type: 'addRules'
  rules: PermissionRule[]
  behavior: 'allow'
  /** session = そのプロセスだけ、localSettings = cwd の .claude/settings.local.json */
  destination: 'session' | 'localSettings'
}

/** `Bash(gh pr:*)` なら { toolName: 'Bash', ruleContent: 'gh pr:*' }。ruleContent 無しはそのツール全部 */
export interface PermissionRule {
  toolName: string
  ruleContent?: string
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
  /** 処理中の返信（窓の外のセッションも含む全部）。これが変わると rev も変わる */
  replying: ReplyingMap
  /** 返信中のエージェントが待っている許可・質問（ID → 古い順）。これが変わると rev も変わる */
  approvals: ApprovalMap
  /** 配っている web/dist/ が web/src / shared より古い（git pull のあと pnpm build していない）。これが変わると rev も変わる */
  build_stale: boolean
  /** 自分の表示名とアイコン。変わると rev も変わる */
  profile: Profile
}

export interface SessionDetailResponse {
  rev: string
  session: SessionSummary
  rows: FeedRow[]
  replying: ReplyingMap
  /** 返信中のエージェントが待っている許可・質問（ID → 古い順）。これが変わると rev も変わる */
  approvals: ApprovalMap
  /** 自分の表示名とアイコン。変わると rev も変わる */
  profile: Profile
}

export interface FeedResponse {
  rev: string
  days: number
  rows: FeedRow[]
  replying: ReplyingMap
  /** 返信中のエージェントが待っている許可・質問（ID → 古い順）。これが変わると rev も変わる */
  approvals: ApprovalMap
  /** 配っている web/dist/ が web/src / shared より古い。SessionsResponse と同じ */
  build_stale: boolean
  /** 自分の表示名とアイコン。変わると rev も変わる */
  profile: Profile
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

/** 一言コメントの性格。'none' は性格なし。表と口調は shared/persona.ts */
export type PersonaId =
  | 'none'
  | 'INTJ' | 'INTP' | 'ENTJ' | 'ENTP'
  | 'INFJ' | 'INFP' | 'ENFJ' | 'ENFP'
  | 'ISTJ' | 'ISFJ' | 'ESTJ' | 'ESFJ'
  | 'ISTP' | 'ISFP' | 'ESTP' | 'ESFP'

/**
 * GET/PUT /api/settings。サーバ側の設定（~/.agent-feed/settings.json）。
 * 一言はサーバが作るので性格もサーバに持つ。digest / model は環境変数（SAI_DIGEST / SAI_DIGEST_MODEL）の状態で、PUT では変えられない
 */
export interface SettingsResponse {
  persona: PersonaId
  /** 一言を作る配線が有効か（SAI_DIGEST=1） */
  digest: boolean
  model: string
}

/** PUT /api/settings の body */
export interface SettingsRequest {
  persona?: PersonaId
}

/** POST /api/digest/backfill?n=20 の応答。列に積んだ数 */
export interface DigestBackfillResponse {
  queued: number
}

export interface SessionFilters {
  repo: string
  agent: string
  date: string
  days: string
  /** '1' ならアーカイブ済みだけを出す。それ以外はアーカイブ済みを除く（クエリ文字列に載せるので文字列） */
  archived: string
}

export interface FeedFilters {
  repo: string
  days: string
}
