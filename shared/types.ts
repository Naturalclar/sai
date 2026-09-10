// agent-feed の1行と、SAI の API の形。サーバ（server/）と画面（web/src/）が両方ここを import する。
// フィールドを足すときはここに足す。JSONL の形は feed/record.py が正本。

import type { Skill } from './skills.ts'

export type Agent = 'claude' | 'codex' | 'opencode' | 'unknown'
export type SessionSource = 'payload' | 'rollout' | 'synth' | ''

/**
 * 行の形の版。feed/record.py の RECORD_VERSION と同じ値（ずれると pnpm test:feed が止まる）。
 * 行の形を変えるたびに上げる。画面は窓の中の一番新しい行の v がこれより古いと「record.py が古い」と出す
 */
export const RECORD_VERSION = 7

/** ~/.agent-feed/YYYY-MM-DD.jsonl の1行 = 1ターン */
export interface FeedRow {
  ts: string
  /** 記録側の版（record.py の RECORD_VERSION）。無い行は試作か古い record.py が書いたもの（1 扱い） */
  v?: number
  agent: Agent
  repo: string
  branch: string
  /** origin の URL（https://host/owner/repo に正規化。record.py の normalize_remote）。無い行は古い record.py が書いたもの。一言の #123 のリンク先に使う */
  remote?: string
  /**
   * どのリポジトリのものか（`Naturalclar/sai`。remote が無ければリポジトリ名だけ）。`repo` は git の toplevel の
   * basename なので bare clone の worktree だと worktree 名になる（#163）。一覧の絞り込みはこちらで行う。
   * 無い行はサーバが remote から補う（shared/project.ts の rowProject）
   */
  project?: string
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
  /**
   * そのターンを回したモデル（`claude-fable-5-1` / `gpt-5.6-sol` など）。Claude は transcript の assistant 行の
   * `message.model`、Codex は rollout の `turn_context.model`。ターン完了の行だけ。古い行には無い
   */
  model?: string
  /**
   * そのターンの許可モード（Claude のフックのペイロードの `permission_mode`。`default` / `plan` /
   * `acceptEdits` / `auto` / `dontAsk` / `bypassPermissions`）。Codex には無い。古い行にも無い
   */
  permission_mode?: string
  /**
   * どのマシンで記録したか（`AGENT_FEED_HOST` か `gethostname()` の短い形。#112）。古い行には無い。
   * 複数マシンの JSONL を 1 か所に集めたとき（#24）に、行の出どころを分けるためのもの
   */
  host?: string
  /** セッションが開いている tmux のペイン（`%12` など。tmux の外なら空）。SAI の返信をここに打ち込む */
  pane?: string
  /** セッション本体（claude / codex）の pid。生きていれば端末で開いている */
  pid?: number
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
  /** 途中で変わったら最後の値。全部は repos に。bare clone の worktree では worktree 名（表示と絞り込みは project を使う） */
  repo: string
  repos: string[]
  /** どのリポジトリか（`Naturalclar/sai`）。一覧の絞り込みと表示はこちら。全部は projects に */
  project: string
  projects: string[]
  /** origin の URL（`https://github.com/Naturalclar/sai`）。一番新しい行のもの。無ければ空。差分の compare リンクに使う */
  remote: string
  branch: string
  branches: string[]
  /**
   * どのマシンで記録されたか（一番新しい行の `host`。#114）。載せない古い行しか無ければ空 = 自分のマシン扱い。
   * 全部は hosts に（出てきた順）。自分のマシンかの判定は `shared/host.ts` の `isRemoteHost()` に 1 つだけある
   */
  host: string
  hosts: string[]
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
  /** 一番新しいターン完了の行のモデル。無ければ空。途中で変わった全部は models に（出てきた順） */
  model: string
  models: string[]
  /** 一番新しい行の許可モード（`permission_mode`）。無ければ空 */
  permission_mode: string
  /** 一番新しい行の pane / pid（JSONL から）。生きているかは見ない（terminal の方を見る） */
  pane: string
  pid: number
  /** 一番新しいターン完了の行の ts（無ければ空）。端末に打ち込んだ返信が終わったかの判定に使う */
  last_turn: string
  /**
   * 端末（tmux）で開いている。一番新しい行に pane と pid があり、pid が生きているときだけ。
   * 返信はこのペインに打ち込む（-p で別プロセスを立てない）。サーバが応答時に載せる（集計は JSONL だけ）
   */
  terminal?: Terminal | null
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
  /**
   * SAI からの返信で使うモデル（`opus` のような別名か `claude-opus-5` のようなモデル名）。無ければ CLI の既定。
   * 返信の `claude -p --resume` には `--model`、Codex app-serverには `turn/start.model` として渡す。
   * `SAI_CODEX_APP_SERVER=0` の従来経路だけ `codex exec resume -m` になる。
   * Claude は `--resume` に `--model` を付けるとセッションのモデル設定そのものが変わる（端末で再開したときもそのモデル）
   */
  model?: string
  /** このセッションの一言（digest）の性格。無ければ全体の既定（settings.json の persona）に従う。変えると以後の行から効く */
  persona?: PersonaId
  /**
   * このセッションでは一言（digest）を作らない（#263）。**あることが「作らない」**で、無ければ作る
   * （`archived_at` と同じ形。`boolean` にすると `mergeMeta()` の「falsy なら消す」に当たって
   * `false` が保存されない）。作らないだけでなく、すでに作ってあるぶんも画面に出さない（`digest.jsonl` は消さない）
   */
  digest_off?: true
  /**
   * SAI から返信するときの許可モード。無ければ CLI の既定（読み取り以外は聞く）。
   * `claude -p --resume` に `--permission-mode` として付く。**そのターン限り**で、セッションには残らない
   * （`--model` と違うところ。確かめた: フラグ付きで回したセッションをフラグ無しで再開すると元に戻る）。
   * 端末（tmux）に打ち込む経路ではフラグを渡す先が無いので効かない
   */
  permission_mode?: ReplyPermissionMode
}

/**
 * GET/PUT /api/sessions/<id>/meta。PUT の body は SessionMeta の一部で、いまの値に重ねる:
 * 省略したキーは据え置き、空文字や null は「消す」。名前を付けるだけ・アーカイブを切り替えるだけ、が互いを消さない
 */
/** `git diff --name-status` の1文字の読み方。`binary` は numstat が `-` のとき */
export type DiffStatusCode = 'added' | 'modified' | 'deleted' | 'renamed' | 'binary' | 'other'

/** 変わったファイル1つぶんの見出し（`--numstat` と `--name-status`）。本文が切れていてもこれは全部返す */
export interface DiffFileStat {
  path: string
  /** リネーム前。無ければ省略 */
  old_path?: string
  status: DiffStatusCode
  added: number
  removed: number
}

/** 差分のひとまとまり。patch は unified diff そのもの（画面が shared/diff.ts で木にする） */
export interface DiffSection {
  files: DiffFileStat[]
  patch: string
  /** 大きすぎて本文の一部を落とした。files は全部入っている */
  truncated: boolean
}

/**
 * GET /api/sessions/<id>/diff?base=。そのセッションの worktree を git で読むだけ（#171）。
 * cwd が git のリポジトリでなければ 404。3 秒のポーリングには載せない（開いたときだけ取る）
 */
export interface SessionDiffResponse {
  id: string
  cwd: string
  /** 比べた相手（`origin/main`）。決まらなければ空で、branch は空になる */
  base: string
  /** いまその worktree がいるブランチ（detached なら短い SHA） */
  head: string
  /** セッションの行の branch。head と違えば画面が注意を出す */
  session_branch: string
  /** GitHub の compare の URL（remote があれば）。切れているときの逃げ道 */
  compare_url: string
  /** base...HEAD。GitHub の PR で見るのと同じもの */
  branch: DiffSection
  /** HEAD からの未コミット */
  working: DiffSection
  /** 追跡外のファイル名（中身は出さない） */
  untracked: string[]
}

/**
 * そのブランチに出ている GitHub の PR（#211）。`gh` が無い・ログインしていない・PR が無ければ
 * 付かない（差分そのものの表示は落とさない）
 */
export interface DiffPr {
  number: number
  url: string
  /** `gh pr view` の state（`OPEN` / `MERGED` / `CLOSED`）。表示は番号だけだが、後で色を変えるときのために持つ */
  state: string
  draft: boolean
}

/**
 * GET /api/sessions/<id>/diff?summary=1。本文（patch）を作らない軽い版（#211）。
 * 入力欄の差分ボタンが「開く前に」行数と PR 番号を出すために使う。
 * 3 秒のポーリングには載せない（セッションを開いたときと、新しいターンが記録されたときだけ）
 */
export interface SessionDiffSummaryResponse {
  id: string
  base: string
  head: string
  /** 変わったファイルの数（ブランチの差分 + 未コミット。同じファイルが両方にあれば 1 つ） */
  files: number
  /** 足した行・消した行の合計（ブランチの差分 + 未コミット） */
  added: number
  removed: number
  /** 内訳。ボタンの title に出す */
  branch: DiffCounts
  working: DiffCounts
  /** 追跡外のファイルの数 */
  untracked: number
  /** そのブランチに出ている PR。無ければ省略 */
  pr?: DiffPr
}

/** 差分の大きさだけ（本文もファイル名も持たない） */
export interface DiffCounts {
  files: number
  added: number
  removed: number
}

/** GET /api/sessions/<id>/skills。`/` の候補。Claude 以外は空 */
export interface SessionSkillsResponse {
  id: string
  skills: Skill[]
}

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
  /**
   * 端末（tmux）のペインに打ち込んだ返信（#232）。省略なら別プロセス（`claude -p` / `codex exec resume`）。
   *
   * **この 2 つは「人を待っているか」の分かり方が違う。** 別プロセスの返信は許可も質問も
   * `--permission-prompt-tool` を通るので、答え待ちがあれば必ず `approvals` に載る（載っていなければ
   * 待っていない）。端末に打ち込んだ返信は SAI に口が無いので、行の `waiting` しか手がかりが無い。
   * 「要対応」（`web/src/todoItems.ts`）がこの違いで出し分ける
   */
  via?: 'terminal'
  /**
   * 返信の子プロセスが非0で終わった（#172）。画面はこれを「処理中」ではなく失敗として出す。
   * `tail` は `reply.log` のそのターンぶんの末尾で、理由（Codex の active writer、CLI が見つからない、など）が入る。
   * サーバは少しの間だけ持っていて（画面が拾えるように）、そのあと消す
   */
  failed?: ReplyFailure
}

export interface ReplyFailure {
  /** プロセスの終了コード。シグナルで死んだときは負の値（-15 なら SIGTERM） */
  code: number
  /** reply.log のそのターンぶんの末尾（数行、300文字まで） */
  tail: string
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
  /** 表示するエージェント。古い値と Claude の MCP 経路は省略（claude 扱い） */
  agent?: Agent
  /** false は検出専用。SAI から答えを返す安全な経路が無いので、端末で回答する案内だけを出す */
  answerable?: boolean
  /** Codex app-server がこのrequestで提示した決定だけ。idから実際のdecisionを引くのはサーバ */
  decisions?: ApprovalDecision[]
}

export interface ApprovalDecision {
  /** 画面へ渡す不透明な値。app-serverのdecision本体はブラウザへ信頼させない */
  id: string
  label: string
  /** 押した後の表示にだけ使う */
  behavior: 'allow' | 'deny'
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
  /** Codex app-serverの承認で、Approval.decisionsから選んだ不透明なid */
  decision?: string
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
  /** リポジトリ（`Naturalclar/sai`）。絞り込みの主軸 */
  projects: string[]
  /** git の toplevel の basename。bare clone では worktree 名（同じリポジトリの中の枝分かれ） */
  repos: string[]
  agents: Agent[]
  dates: string[]
  /** どのマシンで記録されたか（#114）。1 台しか無ければ画面は絞り込みを出さない */
  hosts: string[]
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
  /** 窓の中の一番新しい行の v（無い行は 1、行が無ければ 0）。RECORD_VERSION より小さければ記録側の record.py が古い */
  record_version: number
  /** 自分の表示名とアイコン。変わると rev も変わる */
  profile: Profile
  /** 誰として見ているか。tailnet 経由（tailscale serve）ならログイン名、ローカルの直アクセスなら null */
  viewer: Viewer | null
  /**
   * このサーバが動いているマシンの名前（`SAI_HOST` か `os.hostname()` の短い形。#114）。
   * 画面はこれと `SessionSummary.host` を見て「別のマシンのセッション」の印を出し、返信の口を出さない。
   * 取れなければ空で、そのときは何もリモートにしない
   */
  host: string
}

/** tailnet 経由のアクセス者。Serve のヘッダを `tailscale whois` で突き合わせた後の値 */
export interface Viewer {
  login: string
  name?: string
}

/** GET /api/health */
export interface HealthResponse {
  ok: true
  viewer: Viewer | null
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
  /** このサーバのマシン名（SessionsResponse と同じ。#114）。セッション画面は一覧を持たないのでここにも載せる */
  host: string
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
  /** 誰として見ているか（SessionsResponse と同じ） */
  viewer: Viewer | null
}

/** 検索で当たった発言 1 つ（#230）。飛び先は `#/s/<id>?ts=<ts>` */
export interface SearchHit {
  /** エンティティID */
  id: string
  /** その行の ts。セッション画面はこれで当たった発言まで送る */
  ts: string
  /** 自分の入力（`user_text`）に当たったか、エージェントの返答（`text`）か */
  who: 'me' | 'agent'
  /** セッションの表示名（一覧から引けたとき）。引けなければ ID */
  label: string
  /** リポジトリ / ブランチ。⌘K の候補と同じ */
  hint: string
  icon?: string
  archived?: boolean
  /** 当たったところを中心に切り出した本文（`shared/search.ts` の `excerptOf`） */
  excerpt: string
  /** `excerpt` の中で強調する場所（開始, 長さ）。重なりは畳んである */
  hits: [number, number][]
}

/**
 * GET /api/search?q=&days=90。発言の本文（`text` / `user_text`）を舐めて探す（#230）。
 * **索引は持たない**（実測で 9 日ぶん 1.52MB。重くなったらそのとき考える）。
 * 3 秒のポーリングには載せない（⌘K で打ち終わったときだけ叩く）
 */
export interface SearchResponse {
  q: string
  days: number
  /** 新しい順。上限は shared/search.ts の SEARCH_LIMIT */
  hits: SearchHit[]
  /** 上限で切った（古い方を落とした） */
  truncated: boolean
  /** 舐めた行数。「見つからない」ときに範囲を伝えるため */
  scanned: number
}

/** POST /api/sessions/<id>/reply の body */
export interface ReplyRequest {
  text: string
  /**
   * 端末（tmux）の入力欄に打ちかけの文字があっても、それを消してから打ち込んでよい。
   * 画面が 409（code: terminal_typed）を受けて人に確認したあとに true で送り直す。ダイアログ中には効かない
   */
  replace_typed?: boolean
  /**
   * 送り方。省略（auto）は「端末で開いていればペインに打ち込み、だめなら 409」。
   * process は端末を見ずに送る（Claude と閉じた Codex は resume、開いている Codex は queue）。
   * 端末に打ちかけが消せない・ダイアログ中・入力欄が読めないときの逃げ道（#157）。端末には出ない
   */
  via?: 'auto' | 'process'
  /**
   * 返信に添える画像の絶対パス（`POST /api/sessions/<id>/attachments` が返した `path`）。
   * サーバはそのセッションの置き場のものだけを通す（任意のファイルを CLI に読ませない）。
   * 本文の末尾にパスを足して渡し、Codex にはさらに `-i` でも渡す
   */
  attachments?: string[]
}

/** POST /api/sessions/<id>/attachments。body は画像そのもの */
export interface AttachmentResponse {
  id: string
  /** 返信の `attachments` に入れる絶対パス */
  path: string
  /** <img src> に使う URL */
  url: string
  mime: string
  size: number
}

/**
 * 返信の 409 の body。`error` は今までどおり人向けの文。`code` があれば画面が出し分けられる:
 * - terminal_typed: 端末の入力欄に打ちかけの文字がある（`typed` にその文）。消して送るかを確認できる
 * - terminal_dialog: 端末が許可や質問のダイアログを出している（消させない）
 * - terminal_unknown: 入力欄が見つからない（別のプログラムに打ち込まない）
 */
export interface ReplyError {
  error: string
  code?: 'terminal_typed' | 'terminal_dialog' | 'terminal_unknown'
  typed?: string
  /** true なら `via: 'process'` で送り直せば端末を見ずに別プロセスで回せる（端末に打てない 409 に付く） */
  can_process?: boolean
}

/**
 * 202 で返す。ターンは裏で走るので、結果はそのセッションに増えた行で見る。
 * session は CLI に渡した生のセッションID（エンティティIDではない）
 */
export interface Terminal {
  pane: string
  pid: number
}

export interface ReplyResponse {
  accepted: true
  id: string
  agent: Agent
  /** terminal: tmux。process: 非対話CLI。queue: 開いているCodex。app-server: SAI管理のCodex */
  via: 'terminal' | 'process' | 'queue' | 'app-server'
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
  /** 一言を作る口（SAI_DIGEST_PROVIDER）。claude は `claude -p`、openai は OpenAI 互換の HTTP（Ollama / LM Studio など） */
  provider: DigestProvider
  model: string
  /** Linear の workspace（URL の linear.app/<workspace>/ の部分）。一言の中の PGR-123 のような識別子のリンク先。空なら組まない */
  linear_workspace: string
}

/** 一言を作る口。`claude`（`claude -p`。既定）か `openai`（OpenAI 互換の `/v1/chat/completions`。ローカルの LLM はこちら） */
export type DigestProvider = 'claude' | 'openai'

/** PUT /api/settings の body。省略したキーは据え置き */
export interface SettingsRequest {
  persona?: PersonaId
  /** 空文字で「設定なし」に戻す */
  linear_workspace?: string
}

export interface SessionFilters {
  /** リポジトリ（`Naturalclar/sai`）。主軸 */
  project: string
  /** worktree（git の toplevel の basename）。project の中をさらに絞る */
  repo: string
  agent: string
  date: string
  /** どのマシンで記録されたか（#114）。1 台しか無ければ画面は選択肢を出さない */
  host: string
  days: string
  /** '1' ならアーカイブ済みだけを出す。それ以外はアーカイブ済みを除く（クエリ文字列に載せるので文字列） */
  archived: string
}

export interface FeedFilters {
  /** リポジトリ（`Naturalclar/sai`）。サイドバーの絞り込みに従う */
  project: string
  days: string
}

// ---- 許可（GET /api/sessions/<id>/permissions）

/** 許可モード。Claude Code のフックの `permission_mode` の値 */
export type PermissionMode = 'default' | 'acceptEdits' | 'plan' | 'auto' | 'dontAsk' | 'bypassPermissions'

/**
 * SAI の画面から**選べる**許可モード（`SessionMeta.permission_mode`）。返信の `claude -p` に `--permission-mode` として付く。
 *
 * `bypassPermissions` は**許可を一切聞かなくなる**（#253。issue から PR まで押し続けなくて済むように）。
 * 返信の POST はブラウザから飛ぶので、**これを選んだセッションでは `isCrossOrigin()` が唯一の砦になる**
 * （それまでは「CLI が未許可のツールを拒否する」が二重目の歯止めだった）。画面で目立たせて、選んだことが
 * 分かるようにしてある。`auto` は入れない（「安全性の確認つき」の中身が CLI 任せで、説明できないため）。
 * 実測（Claude Code 2.1.266）: **ツールの許可は `--permission-prompt-tool` を素通りするが、
 * `AskUserQuestion` の質問は素通りしない**ので、質問のバブルは今までどおり出て答えられる
 */
export type ReplyPermissionMode = 'acceptEdits' | 'bypassPermissions'

/** ルールの種類。評価は deny → ask → allow の順で、最初に当たったものが決まる */
export type PermissionKind = 'deny' | 'ask' | 'allow'

/**
 * ルールの出どころ。強い順は managed > local > project > user だが、deny はどの出どころでも allow に勝つ。
 * `sai_args` は SAI_CLAUDE_ARGS の `--allowedTools` / `--disallowedTools` で、SAI から返信したターンにだけ効く
 */
export type PermissionSourceKind = 'managed' | 'local' | 'project' | 'user' | 'sai_args'

/** 読んだ設定ファイル 1 つ分 */
export interface PermissionSource {
  kind: PermissionSourceKind
  /** 読んだファイルの絶対パス。`sai_args` は環境変数名 */
  path: string
  /** ファイルが無い（`sai_args` なら未設定） */
  missing?: boolean
  /** あるが JSON として読めない */
  broken?: boolean
  /** そのファイルの `permissions.defaultMode` */
  default_mode?: string
}

export interface PermissionRuleEntry {
  kind: PermissionKind
  /** `Bash(gh pr:*)` / `mcp__github__create_issue` のような表記そのまま */
  rule: string
  source: PermissionSourceKind
}

/** GET /api/sessions/<id>/permissions。そのセッションの cwd から読む（読むだけ） */
export interface SessionPermissionsResponse {
  id: string
  cwd: string
  agent: Agent
  /** 一番新しい行の許可モード。無ければ空 */
  mode: string
  /** 読んだ先（無かったものも含む。どこを直せばいいか分かるように） */
  sources: PermissionSource[]
  /** deny → ask → allow の順 */
  rules: PermissionRuleEntry[]
}

/** 使用量の枠 1 つ。Codex の rate_limits の primary（5 時間）/ secondary（週） */
export interface UsageWindow {
  /** 0〜100 */
  used_percent: number
  /** 枠の長さ（分）。300 なら 5 時間、10080 なら 1 週間 */
  window_minutes: number
  /** 枠が戻る時刻（epoch 秒）。載っていないことがある */
  resets_at?: number
}

/** Codex の使用量。rollout の token_count の行から読む（口座単位なので画面に 1 つ） */
export interface CodexUsage {
  primary: UsageWindow
  secondary?: UsageWindow
  /** plan_type（`plus` など） */
  plan?: string
  /** 拾った行の時刻（ISO）。いつ時点の値か */
  at: string
}

/** いま上限に当たっている記録（transcript の quotaLimits が `status: rejected`） */
export interface ClaudeLimited {
  /** 戻る時刻（epoch 秒） */
  resets_at: number
  /** rateLimitType（`five_hour` など）。無ければ空 */
  kind: string
}

/**
 * Claude の使用量。**出どころが 2 つあり、片方しか無いことがある**（#250）:
 *   - 割合（`primary` / `secondary`）… ステータスライン経由（`feed/statusline.py`）。
 *     設定していない・subscription でない・Claude をまだ動かしていないときは付かない
 *   - `limited` … transcript の `quotaLimits`。**上限に弾かれたときにしか載らない**
 */
export interface ClaudeUsage {
  /** 5 時間の枠 */
  primary?: UsageWindow
  /** 週の枠 */
  secondary?: UsageWindow
  /** いま上限に当たっている */
  limited?: ClaudeLimited
  /** いつ時点の値か（ISO）。Claude が動いていない間は増えない */
  at: string
}

/**
 * GET /api/usage。ローカルのファイルから読むだけで、API は叩かない（「SAI は外に出さない」）。
 * 取れなかったエージェントはキーごと付かない（画面は黙って出さない）
 */
export interface UsageResponse {
  codex?: CodexUsage
  claude?: ClaudeUsage
}
