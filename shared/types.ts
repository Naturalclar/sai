// agent-feed の1行と、SAI の API の形。サーバ（server/）と画面（web/src/）が両方ここを import する。
// フィールドを足すときはここに足す。JSONL の形は feed/record.py が正本。

import type { BashNoRuleReason } from './bashRules.ts'
import type { EventKind } from './events.ts'
import type { Skill } from './skills.ts'
import type { TurnUsage } from './turnUsage.ts'

export type Agent = 'claude' | 'codex' | 'opencode' | 'grok' | 'unknown'
export type SessionSource = 'payload' | 'rollout' | 'synth' | ''

/**
 * 行の形の版。feed/record.py の RECORD_VERSION と同じ値（ずれると pnpm test:feed が止まる）。
 * 行の形を変えるたびに上げる。画面は窓の中の一番新しい行の v がこれより古いと「record.py が古い」と出す
 */
export const RECORD_VERSION = 9

/** record.py が切った本文の項目（#358。FeedRow.clipped） */
export type ClippedField = 'text' | 'user_text' | 'thinking' | 'questions'

/**
 * 質問の待ちの行に載る、質問の形（#334。record.py の `question_structure()`）。キーの名前は `AskUserQuestion` の
 * `tool_input.questions` と同じなので、画面は `shared/approvals.ts` の `askQuestions({ questions })` にそのまま渡せる
 */
export interface RowQuestion {
  question: string
  header: string
  multiSelect: boolean
  options: { label: string; description: string }[]
}

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
  /**
   * 本文が長すぎて record.py が切った項目（#358）。切ったものだけが入り、切っていなければキーごと無い。
   * 画面はその本文の末尾に「ここで切れています」を出す（切ったことが分からないと、そこで終わったのか
   * 切られたのかが読めない）。上限は record.py の MAX_TEXT / MAX_USER_TEXT / MAX_THINKING
   */
  clipped?: ClippedField[]
  /**
   * `AskUserQuestion` の待ちの行（`PreToolUse` / `PermissionRequest`）の質問と選択肢（#334。v9 から）。
   * text は文だけなので、選択肢はここから出す。無い古い行は #333 の transcript から読む方に落ちる
   */
  questions?: RowQuestion[]
  first_user_text?: string
  /**
   * text をチャットの一言コメントに言い換えたもの（性格つき）。JSONL には無く、サーバが応答時に
   * ~/.agent-feed/digest.jsonl から載せる（server/digest/digest.ts）。無ければ省略で、画面は text を出す
   */
  summary?: string
  /**
   * 一言の「人が次にすること」（#713）。本文の文そのままで、口調は付いていない。**これがある行の `summary` は
   * 「何が起きたか」だけ**（2 つで組んだ一言を、画面が場所ごとに出し分ける）。無い行の `summary` は 1 つの一言
   * （報告だけの回・2 つに分かれていない前の一言）。`summary` と同じく JSONL には無い
   */
  summary_next?: string
  /**
   * そのターンが使ったトークンと費用（#411）。JSONL には無く、サーバが応答時に
   * ~/.agent-feed/turn-usage.jsonl から載せる（server/reply/turnUsage.ts）。
   * **SAI が起こした Claude のターンだけ**に付く（端末で打ったターン・Codex / OpenCode・別のマシンには付かない）
   */
  usage?: TurnUsage
  /**
   * 別のセッションへ送ったメッセージの返答として、**送り元の**セッション画面に並べるときだけ付く（#588）。
   * 行そのものは相手のセッションのターン完了の行で、JSONL には無い（サーバが詳細の応答に `agent_replies` として載せる）
   */
  agent_reply?: AgentReplyTag
  /**
   * ターン完了の行が落ちた・本文が空だったので、**サーバが transcript から補った**（#614）。JSONL には無く、応答にだけ載る
   * （`shared/recoveredTurns.ts`）。画面は「記録から補った」の印を付ける。`turns` には数えない
   */
  recovered?: true
}

/**
 * 人が送り元の画面の「返答のバブル」の下から、相手のセッションへ直接送った返信（#700）。チャットのバブルにはせず、
 * そのバブルの下の小さい 1 行に出す。本文は頭だけ（`FOLLOWUP_SHOWN_CHARS`）
 */
export interface AgentFollowupLine {
  id: string
  /** 相手のエンティティ ID */
  to: string
  to_name: string
  /** 送った文の頭 */
  text: string
  sent_at: string
  /** どのバブルの下から送ったか（その返答の行の `ts`） */
  anchor: string
  /** 相手がこの返信に返した行の `ts`。まだ無ければ無い（その行は `agent_replies` に `followup` の印つきで載る） */
  reply_ts?: string
}

/** 送り元の画面に並べる返答の印（#588） */
export interface AgentReplyTag {
  /** 送ったメッセージの id。`followup` のときは、人がこの画面から送った返信（`AgentFollowupLine.id`） */
  message_id: string
  /**
   * 人が**この画面の返答のバブルの下から**相手へ送った返信への返答（#700）。`sai_send` の返答ではないので、
   * 送り元のエージェントの会話には渡さない（`handed_at` は付かず、画面も「渡した / 渡す」の印を出さない）
   */
  followup?: true
  /** 相手の呼び名（表示名 → 題名 → ID） */
  to_name: string
  /** 相手のアイコンの URL（#666。`SessionSummary.icon` と同じ形）。付けていなければ無い（画面は頭文字を出す） */
  to_icon?: string
  /** 送った時刻 */
  sent_at: string
  /**
   * 送り元の会話（エージェントの文脈）に渡した時刻（#594。次のターンの頭に足したか、`sai_wait` で受け取った）。
   * 無ければまだ渡していない（次に SAI から送り元のターンを回すときに足す）
   */
  handed_at?: string
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
   * 一覧の「待機中」の印と、チャット見出しに出す。
   * **「終わって次を待っている」（`入力待ち`）はここには入らない**（下の `idle`。#438）
   */
  waiting: string
  /**
   * ターンが終わって放置されている（`入力待ち`。#438）。最後の行が `idle` の行ならその text。
   * 詰まっているわけではないので、要対応では下段（`done`）に置き、バッジにも通知にも数えない
   */
  idle: string
  /**
   * 最後の行の読み方（`eventKind()`。#513）。`turn` なら「ターンが終わって次の指示を待っている」。
   * **時刻の比較（`end === last_turn_ts`）では決めない**: 行の `ts` は秒までなので、ターン完了と同じ秒に届いた
   * 次の入力（`UserPromptSubmit`）や `/clear` の `SessionEnd` と見分けが付かない（#517 のレビュー）
   */
  last_kind?: EventKind
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
  /**
   * 最後のターンの一言の「人が次にすること」（#713。`FeedRow.summary_next` と同じ読み方）。これがあるとき
   * `last_summary` は「何が起きたか」だけ。要対応の行はこちらを先に出し、一覧の「最後の発言」は `last_summary` だけを出す
   */
  last_summary_next?: string
  /**
   * 次に送る文面の案（#371）。一言（digest）と同じ口・同じタイミングで、一番新しいターン完了の行の分だけ作る。
   * 無ければ省略。入力欄が空のときだけチップに出す（`web/src/nextAskChip.ts`）
   */
  next_ask?: string
  /**
   * ターンは終わっているのに、ターン完了（`Stop`）の行が記録されていない（#614）。サーバが transcript と突き合わせて、
   * **分かったときだけ**載せる（`shared/stopMissing.ts`）。要対応・未読・`turns` には数えない。無ければ省略
   */
  stop_missing?: true
  /**
   * Manager が置いた案（#565。`sai_suggest`）。**置いてから 24 時間以内で、そのあと人の入力が来ていない**（置いた時刻より後の行で決める）ときだけ
   * サーバが `suggestions.json` から載せる（`shared/managerDraft.ts`）。入力欄が空のとき、`next_ask` より先に出す
   */
  manager_draft?: ManagerDraft
  /**
   * 一番新しい自分の入力（ターン完了の行か入力の行の `user_text`）の 1 行目（#300）。
   * 一覧の 2 行目で「最後に言ったのが自分か」を決めるのに使う（`web/src/sessionPreview.ts`）。集計が付けるので、手で組む fixture では省略可
   */
  last_user_text?: string
  /** その行の ts。ターン完了の行に載っている入力なら `last_turn_ts` と同じになる */
  last_user_ts?: string
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
  /**
   * まだ読んでいないターン完了の数（#502。`shared/unread.ts` の `unreadCounts()`）。サーバが `read-marks.json` の印と
   * 窓の中の行から応答時に数える。0 なら省略
   */
  unread?: number
  /**
   * 同じ project の中で同じ名前のセッションがあるときだけの、見分けの添え字（#572。`9/2〜` か ID の頭）。
   * サーバが一覧を組むときに付ける（`shared/sessionLabels.ts` の `labelSuffixes()`）。名前を出す所は `withSuffix()` を通す
   */
  label_suffix?: string
  /** どこまで読んだか（#502。ミリ秒）。セッション画面の「ここから未読」の線はこれより新しい最初の返答の前に引く */
  read_at?: number
}

/** Manager が宛先の入力欄に置いた案（#565）。~/.agent-feed/suggestions.json に宛先のエンティティ ID ごとに 1 つ */
export interface ManagerDraft {
  text: string
  /** 置いた呼び出し元（`このマシン` か tailnet のログイン名）。reply.log に残すためで、画面には出さない */
  from: string
  /** 置いた時刻（ミリ秒）。捨てる・入れるときに「同じ案か」の鍵にもする */
  at: number
  /** 置いたときに宛先のターンが回っていたか。回っていたターンが終わっただけでは消さない（`shared/managerDraft.ts`） */
  busy: boolean
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
  /** 引き継いで始めたセッション（#442）の、前のセッションのエンティティ ID。見出しに「← 前のセッション」を出す */
  continued_from?: string
  /** 分岐元のセッションの ID（#405。Codex の `thread/fork` で作ったセッションに、サーバが書く） */
  forked_from?: string
  /** 引き継いだ先のセッションのエンティティ ID（#442）。見出しに「→ 続き」を出す。前のセッションはアーカイブしない */
  continued_to?: string
  /** `continued_to` を始めたときに使った引き継ぎの行の `ts`（#442）。同じ引き継ぎで 2 回始めないための印 */
  continued_at?: string
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
  /** `APPROVED` / `CHANGES_REQUESTED` / `REVIEW_REQUIRED`、無ければ空（#636。承認済みならチェックの印）。古いサーバの応答には無い */
  review_decision?: string
}

/**
 * GET /api/sessions/<id>/files/<key>（#603）。返答に出てきた手元のファイルの中身。**文字のファイルだけ**で、画面も文字として見せる
 * （HTML を描かない）。`<key>` は本文に書かれたパスの鍵（パスはリクエストから受けない）。読めなければ理由つきの 4xx
 */
export interface SessionFileResponse {
  /** 本文に書かれたパスそのもの */
  path: string
  /** ファイル名 */
  name: string
  text: string
  /** 中身の大きさ（バイト） */
  bytes: number
}

/** PR のチェック（CI）をまとめた状態（#524）。チェックが 1 つも無ければ空 */
export type PrCheckState = 'success' | 'failure' | 'pending' | ''

/** GitHub に出ている PR の 1 件（#524。`gh pr list` / `gh pr view` を読んだもの）。**読むだけ** */
export interface PrSummary {
  number: number
  title: string
  /** 出した人の GitHub のログイン名 */
  author: string
  /** head のブランチ */
  head: string
  /** base のブランチ */
  base: string
  draft: boolean
  /** 最後に動いた時刻（ISO） */
  updated_at: string
  url: string
  additions: number
  deletions: number
  changed_files: number
  /** `APPROVED` / `CHANGES_REQUESTED` / `REVIEW_REQUIRED`、無ければ空 */
  review_decision: string
  checks: PrCheckState
  /** 自分（`gh` でログインしている人）にレビューが頼まれている */
  requested: boolean
  /**
   * 別のリポジトリ（fork）のブランチから出た PR（`isCrossRepository`）。**サイドバーのセッションには結ばない**（#548 のレビュー。
   * `head` はブランチ名だけなので、fork の同じ名前のブランチから出た他人の PR が手元のセッションに付いてしまう）
   */
  cross?: boolean
}

/** 1 つのリポジトリの open な PR。`error` があれば引けなかった（prs は空） */
export interface PrRepo {
  /** `owner/repo` */
  repo: string
  prs: PrSummary[]
  error?: string
}

/**
 * GET /api/prs（#524）。SAI が記録で知っている GitHub のリポジトリの open な PR。3 秒のポーリングには載せない
 * （開いたときと「読み直す」を押したときだけ）。`available` が false なら `gh` が使えない・`SAI_GH=0`
 */
export interface PrsResponse {
  rev: string
  available: boolean
  repos: PrRepo[]
}

/** PR に付いている会話のコメント・レビューの 1 件（#600。`gh pr view --json comments,reviews` を読んだもの）。**読むだけ** */
export interface PrComment {
  /** GitHub の node id（並べるときの key） */
  id: string
  /** `comment` は PR の下に並ぶ会話のコメント、`review` はレビューの本文と判定 */
  kind: 'comment' | 'review'
  /** 書いた人の GitHub のログイン名。消えたアカウントは空 */
  author: string
  /** 書いた時刻（ISO。レビューは送った時刻） */
  at: string
  /** 本文（Markdown）。上限で切ったら `truncated` */
  body: string
  /** GitHub のそのコメントへのリンク。レビューには無い（空） */
  url: string
  /** レビューの判定（`APPROVED` / `CHANGES_REQUESTED` / `COMMENTED` / `DISMISSED`）。会話のコメントには無い */
  state?: string
  /** 畳んで出す理由。`minimized` は GitHub で畳まれたもの、`bot` は bot が書いたもの。画面は 1 行にして、押すと開く */
  folded?: 'minimized' | 'bot'
  truncated?: boolean
}

/** PR の差分の行に付いたコメントの 1 件（#600。`gh api repos/<repo>/pulls/<番号>/comments` を読んだもの）。**読むだけ** */
export interface PrLineComment {
  /** GitHub のコメントの番号 */
  id: number
  /** 返信なら、やり取りの最初のコメントの `id` */
  reply_to?: number
  path: string
  /** `old` は左（base）側、`new` は右（head）側 */
  side: 'old' | 'new'
  /** **いまの差分**でのその側の行番号。前の版へのコメント（outdated）とファイル全体へのコメントは 0 */
  line: number
  /** 書かれたときの行番号（当てられなかったコメントの目安に出す）。無ければ 0 */
  original_line: number
  /** コメントの付いた行の中身（`diff_hunk` の最後の行）。画面はいまの差分のその行と同じときだけ行に出す。取れなければ省略 */
  code?: string
  /** 行ではなくファイル全体へのコメント */
  file_level?: boolean
  author: string
  at: string
  /** 本文（Markdown）。上限で切ったら `truncated` */
  body: string
  /** GitHub のそのコメントへのリンク */
  url: string
  bot?: boolean
  truncated?: boolean
}

/** GET /api/prs/<owner>/<repo>/<番号>（#524）。PR 1 本の中身と差分。差分は `gh pr diff` を読んだもの */
export interface PrDetailResponse {
  repo: string
  pr: PrSummary & {
    /** 本文（Markdown） */
    body: string
    /** `OPEN` / `MERGED` / `CLOSED` */
    state: string
    /** head のコミット */
    head_sha: string
    /**
     * フォークから出た PR（`isCrossRepository`）。head のブランチ名は出した人のリポジトリのもので、
     * 手元のセッションのブランチと名前が同じでも関係が無い（#525 の「書いたセッション」を探さない）
     */
    cross_repo: boolean
  }
  /** base...head の差分。上限は #171 と同じ（超えたら本文を落として truncated） */
  diff: DiffSection
  /** 差分そのものを引けなかった理由（大きすぎる・時間切れ）。引けたら省略 */
  diff_error?: string
  /**
   * GitHub にレビューとして投稿できるとき（#526）の材料。`gh` が無い・未ログイン・`SAI_GH=0` なら省略（口を出さない）。
   * `viewer` は `gh` でログインしている人、`own` はその人が出した PR か（GitHub が自分の PR への Approve / Request changes を受けないので、種類を Comment に絞る）
   */
  review?: { viewer: string; own: boolean }
  /** 会話のコメントとレビュー（#600）。時刻の古い順。読めなければ省略して `comments_error` */
  comments?: PrComment[]
  /** 件数の上限で落とした古いコメントの数。落としていなければ省略 */
  comments_omitted?: number
  /** コメントだけ読めなかった理由（本文と差分は出す） */
  comments_error?: string
  /** 差分の行に付いたコメント（#600 の案 2）。時刻の古い順。行に当てるのは画面（`placeLineThreads()`）。読めなければ省略して `line_comments_error` */
  line_comments?: PrLineComment[]
  /** 件数の上限で落とした古い行コメントの数。落としていなければ省略 */
  line_comments_omitted?: number
  /** 行コメントだけ読めなかった理由（ほかは出す） */
  line_comments_error?: string
}

/** GitHub のレビューの種類（#526）。既定は COMMENT で、ほかは人が明示的に選んだときだけ */
export type PrReviewEvent = 'COMMENT' | 'APPROVE' | 'REQUEST_CHANGES'

/**
 * レビューに載せる行コメント 1 件（#526）。**位置はそのまま GitHub に渡さない**: サーバがいまの PR の差分でその行を探し、
 * 中身（`code`）が書いたときと同じときだけ GitHub の `path` / `line` / `side` に組み立てる。合わなければ 409 で送らない
 */
export interface PrReviewLineComment {
  path: string
  /** `old` は消した行（旧い側の行番号）、`new` は足した行と文脈の行（新しい側） */
  side: 'old' | 'new'
  line: number
  /** コメントを書いたときのその行の中身 */
  code: string
  body: string
}

/** POST /api/prs/<owner>/<repo>/<番号>/review（#526）。**同一オリジンのみ** */
export interface PrReviewRequest {
  event: PrReviewEvent
  /** 全体のコメント。空でもよい（REQUEST_CHANGES と、行コメントの無い COMMENT は要る） */
  body: string
  /** 画面が読んだときの head の SHA。いまの head と違えば 409（`head_moved`）で送らない */
  commit_id: string
  comments: PrReviewLineComment[]
}

/** 投稿できたときの応答（#526）。`url` は GitHub のそのレビュー */
export interface PrReviewResponse {
  ok: true
  url: string
  event: PrReviewEvent
}

/** 処理中のターンの 1 手順（#302）。サーバが transcript / rollout の末尾から読む（`shared/progress.ts`） */
export interface ProgressStep {
  /** tool = ツールを呼んだ、thinking = 考えた（中身は出さない）、text = 返答を書いた */
  kind: 'tool' | 'thinking' | 'text'
  /** ツール名（kind が tool のときだけ） */
  tool?: string
  /** 何をしているか（Bash の description かコマンド、読むファイルなど）。1 行に切ってある。無ければ空 */
  summary: string
  /** 始まった時刻（ISO） */
  started: string
  /** 終わった時刻。まだ走っているツールには無い */
  ended?: string
}

/** ターンの途中でエージェントが書いた文（#680。Codex の `commentary`・Claude のツールの合間の文）。最後の返答は入らない */
export interface ProgressNote {
  /** 本文（Markdown。2000 字まで） */
  text: string
  /** 書いた時刻（ISO） */
  at: string
}

/**
 * GET /api/sessions/<id>/progress（#302）。処理中のターンが何をしているか。
 * 3 秒のポーリング（一覧・詳細）には載せず、画面が処理中のセッションを出している間だけそのセッションの分を取る
 */
/**
 * エージェント自身の段取りの 1 件（#397。OpenCode の `GET /session/<id>/todo`）。
 * **`id` は無い**（並びがそのまま順番）。読み方は `shared/todos.ts`
 */
export interface SessionTodo {
  content: string
  /** `pending` / `in_progress` / `completed` / `cancelled` */
  status: string
  /** `high` / `medium` / `low` */
  priority: string
}

export interface SessionProgressResponse {
  /** transcript / rollout の (mtime, size) と active。変わらなければ画面は描き直さない */
  rev: string
  id: string
  /** ターンの途中か（ターンが閉じておらず、止まったまま古くなってもいない） */
  active: boolean
  /** 最後のターンの直近の手順（古い順、最大 `PROGRESS_STEPS` 件）。読めなければ空 */
  steps: ProgressStep[]
  /** 最後のターンの手順の数（steps は末尾だけなので、それより前にいくつあったか） */
  total: number
  /**
   * 最後のターンの途中でエージェントが書いた文（#680。古い順、末尾の `PROGRESS_NOTES` 件）。無ければ省く。
   * 処理中の仮バブルに出すためのもので、行（JSONL）には無い
   */
  notes?: ProgressNote[]
  /** 途中の文の数（notes は末尾だけなので、それより前にいくつあったか）。notes が無ければ省く */
  notes_total?: number
  /** transcript / rollout が最後に書かれた時刻（ISO）。読めなければ空 */
  updated_at: string
  /**
   * **開いているターンの始まり**（#693。Codex だけ。rollout の `task_started` の時刻）。閉じている・始まりを見ていなければ省く。
   * Codex は入力の行を書かないので、端末で打ったターンの「処理中」の起点に使う
   */
  turn_since?: string
  /**
   * **最後のターンが閉じた時刻**（#693。Codex だけ。`task_complete` / `turn_aborted`）。止めたターンはターン完了の行が来ないので、
   * 答えた許可（`answered`）を「そのターンは終わった」と片付けるのに使う
   */
  turn_closed?: string
  /**
   * 最後のターンが**閉じている**とき、その最後の手順の時刻（#614。Claude だけ）。閉じていない・手順が無い・読めなければ省く。
   * ターン完了の行が落ちたかの判定（`shared/stopMissing.ts`）に使う
   */
  closed_at?: string
  /**
   * 最後にモデルを呼んだときに読んだ量（トークン。#311）。そのセッションに送ると、少なくともこれだけ読み直す。
   * セッション同士のメッセージの予算に使う。読めなければ 0
   */
  context_tokens: number
  /** いま答えを待っている `AskUserQuestion`（#333。Claude だけ）。無ければ省く */
  question?: PendingQuestion
  /**
   * エージェント自身の段取り（#397。**OpenCode だけ**）。空なら省く。
   * 手順（`steps`）は「いま何をしているか」で、こちらは「全体のどこまで来たか」
   */
  todos?: SessionTodo[]
  /** そのターンが起こしたサブセッションの数（#397。OpenCode だけ）。0 なら省く */
  children?: number
}

/**
 * 端末で開いた Claude のセッションが答えを待っている `AskUserQuestion`（#333）。フックの待ちの行には質問の文しか無いので、
 * transcript の、返事（`tool_result`）がまだ付いていない `tool_use` から取る
 */
export interface PendingQuestion {
  /** `tool_use` の `input` そのまま（`questions`）。画面は `shared/approvals.ts` の `askQuestions()` で質問にする */
  input: Record<string, unknown>
  /** `tool_use` が書かれた時刻（ISO） */
  asked_at: string
  /** 待ちの行と同じ 1 行（`質問: …`。`approvalText()`）。サーバはこの文が行の待ちと同じときだけ詳細に載せ、画面はこの文のバブルに出す */
  text: string
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

/**
 * GET /api/sessions/<id>/models。返信で選べるモデルの候補（#394。`provider/model`）。
 * **記録に出てきたモデル（`SessionSummary.models`）とは別**で、本体に聞いたもの。
 * いまは OpenCode だけで、ほかは空（Claude / Codex は今までどおり記録から組み立てる）
 */
export interface SessionModelsResponse {
  id: string
  models: string[]
}

export interface SessionMetaResponse {
  id: string
  meta: SessionMeta
}

/**
 * PUT /api/sessions/<id>/read（#502。同一オリジンのみ）。`ts` のターン完了まで読んだ印を置く。
 * **既読は前にしか進めない**（別の端末で先まで読んだのを古い画面で戻さない）。`back: true` は「ここから未読にする」で、
 * `ts` の発言の直前まで印を戻す
 */
export interface ReadRequest {
  ts: string
  back?: boolean
}

export interface ReadResponse {
  id: string
  /** 置いたあとの印（ミリ秒） */
  read_at: number
}

/**
 * POST /api/sessions/<id>/suggestion（#565。同一オリジンのみ）。Manager が置いた案を捨てる・入力欄に入れた。
 * どちらも案を取り除いて reply.log に 1 行残す。`at` は画面が見ている案の `ManagerDraft.at`（間に置き直された新しい案は消さない）
 */
export interface SuggestionActionRequest {
  action: 'accept' | 'discard'
  at: number
}

export interface SuggestionActionResponse {
  id: string
  /** 取り除いたか（もう無い・置き直されていたら false） */
  taken: boolean
}

/**
 * PUT/DELETE /api/sessions/<id>/icon。PUT の body は画像そのもの（PNG / JPEG / GIF / WebP、1MB まで）。
 * icon は置いた画像の URL（SessionSummary.icon と同じ形）、消したら null
 */
export interface SessionIconResponse {
  id: string
  icon: string | null
}

/** 今まで使ったアイコン画像の 1 つ（#465）。`key` は中身の sha1 の先頭 16 桁 */
export interface IconHistoryItem {
  key: string
  /** `<img src>` に使う URL（`/api/icon-history/<key>?v=…`） */
  url: string
  /** 最後に使った時刻（ISO）。並びはこれの新しい順 */
  used_at: string
}

/**
 * GET /api/icon-history（#465）。`?id=<セッション>` か `?profile=1` を付けると、
 * いまそのアイコンになっている画像の鍵を `current` に載せる（無ければ省く）
 */
export interface IconHistoryResponse {
  items: IconHistoryItem[]
  current?: string
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
 * 正本はサーバのメモリ（server/reply/runner.ts）で、子プロセスが exit するまで残る。画面はこれを「送信中」の正とする
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
   * 「要対応」（`shared/todoItems.ts`）がこの違いで出し分ける
   */
  via?: 'terminal'
  /**
   * いまこのターンを SAI から止められる（#384）。**SAI の app-server が回している Codex のターン**
   * （`turn/interrupt` は自分が `thread/resume` したスレッドしか止められない）、SAI が起こした OpenCode のターン（#392）、
   * **入力の口（stream-json）を開けている `claude -p` のターン**（#386。`result` が出るまで）に付く。画面はこれを見て
   * 仮バブルに「止める」を出す。端末に打ち込んだターンと、立て直しで引き取った `claude -p` には付かない
   */
  interruptible?: true
  /**
   * 要約（`/compact`）だけのターン（#579）。画面は仮バブルに「要約中」と出し、本文は預かりのバブルで見せる。
   * 記録に行は書かれない（2.1.285 で実測）ので、終わりはプロセスの終了で分かる
   */
  compact?: true
  /**
   * このターンを**起動したときに** SAI の設定から付けた許可モード（#272）。`''` はフラグを付けなかった（CLI の既定）。
   * 省略は「分からない」（端末に打ち込んだ返信・Codex / OpenCode・この項目より前のサーバが書いた replying.json）。
   *
   * 許可モードは `claude -p` の起動引数でしか渡せず、**動いている CLI には後から当てられない**。処理中に画面で
   * 「素通し」へ変えても、そのターンは起動したときのモードのまま許可を聞いてくる。画面はセッションのメタの値と
   * これを比べて「次の返信から」と出す（`shared/permissions.ts` の `launchedModeNote()`）
   */
  permission_mode?: string
  /**
   * 返信の子プロセスが非0で終わった（#172）。画面はこれを「処理中」ではなく失敗として出す。
   * `tail` は `reply.log` のそのターンぶんの末尾で、理由（Codex の active writer、CLI が見つからない、など）が入る。
   * サーバは少しの間だけ持っていて（画面が拾えるように）、そのあと消す
   */
  failed?: ReplyFailure
}

export interface ReplyFailure {
  /**
   * プロセスの終了コード。シグナルで死んだときは負の値（-15 なら SIGTERM）。
   * **プロセスの無い経路（端末に打ち込んだ・開いている Codex の queue に渡した）で届かなかったときは無い**（#329）
   */
  code?: number
  /** reply.log のそのターンぶんの末尾（数行、300文字まで）。届かなかったときはその理由 */
  tail: string
  /**
   * **届いたが、ターンがエラーで終わった**（#475。Codex の上限・モデルが無い など）。終了コードが無いのは「届いていない」と同じなので、
   * これが無いと画面が「返信が届いていません」と出し、届いた指示を送り直させてしまう
   */
  turn_error?: true
  /**
   * **Claude のログインが切れている**と分かっている（#685。失敗したときに `claude auth status --json` を聞いた結果）。
   * 画面は失敗の理由としてそれを出す。聞けなかった・切れていなければ無い
   */
  logged_out?: true
}

/** `POST /api/claude-auth/check` の応答（#685）。聞き直した結果。分からなければ（`claude` が無い・古い・時間切れ）`null` */
export interface ClaudeAuthCheckResponse {
  logged_in: boolean | null
}

/** エンティティID → 処理中の返信。無ければ空 */
export type ReplyingMap = Record<string, Replying>

/**
 * 処理中に送って預かっている返信 1 件（#305）。前のターンが終わったらサーバが古い順に 1 件ずつ回す。
 * 正本はサーバ（`server/reply/replyQueue.ts`。メモリと `~/.agent-feed/reply-queue.json`）
 */
export interface QueuedReply {
  /** 取り消しに使う */
  queue_id: string
  /** 送る文。添えた画像のパスは末尾に足してある（画面は `splitAttachments()` で分ける） */
  text: string
  /** 預けた時刻 */
  since: string
}

/** そのセッションの預かり（古い順） */
export interface ReplyQueue {
  items: QueuedReply[]
  /**
   * 自動では回さない理由（前の返信が失敗した・預かった返信を起動できなかった）。無ければ回す。
   * 失敗したターンの続きを黙って積み上げないため。画面の「続けて送る」（`POST .../queue/resume`）で再開する
   */
  paused?: string
}

/** エンティティID → 預かっている返信。無ければ空 */
export type ReplyQueueMap = Record<string, ReplyQueue>

/**
 * ループの状態（#634）。`running` は回っている（周のターン中か、次に起こす時刻を待っている）、`paused` は人の操作か
 * 起こせない事情で止まっている（「再開」で続く）。残りは終わり: `done`（エージェントが条件を満たしたと言った）・
 * `gave_up`（エージェントが進められないと言った）・`stopped`（上限・失敗・使用量・進んでいない・人が止めた）
 */
export type LoopStatus = 'running' | 'paused' | 'done' | 'gave_up' | 'stopped'

/**
 * セッションに組んだループ（#634）。**目的と終わりの条件は人が決め、次にいつ起きるか・終わったかはエージェントが周の終わりに言い
 * （`sai_loop_next`）、上限と止めることは SAI が持つ**。正本はサーバ（`server/reply/loops.ts`。メモリと `<feed dir>/loops.json`）
 */
export interface Loop {
  /** 目的（人が書く） */
  goal: string
  /** 終わりの条件（人が書く。確かめられる形で） */
  until: string
  /** 周の数の上限 */
  max_rounds: number
  /** これを過ぎたら次の周を起こさない */
  deadline: string
  /** エージェントが次の時刻を言わなかったときの間隔（秒） */
  interval_s: number
  status: LoopStatus
  /** 送った周の数（0 はまだ 1 周も送っていない） */
  round: number
  /** 次に起こす時刻。周のターンが回っている間と、終わったループには無い */
  next_at?: string
  /** 前の周の申し送り（エージェントが `sai_loop_next` で言った文）。次の周の頭に SAI が渡す */
  note?: string
  /** 止まっている・終わった理由（`done` ならエージェントが言った根拠） */
  reason?: string
  /** 組んだ時刻 */
  since: string
  /** いま周のターンが回っている */
  turning?: true
}

/** エンティティID → ループ。無ければ空 */
export type LoopMap = Record<string, Loop>

/** `POST /api/sessions/<id>/loop`（ループを組む。同一オリジンのみ）。数字は省略すると既定値で、範囲の外は丸めずに 400 */
export interface LoopRequest {
  goal: string
  until: string
  max_rounds?: number
  /** 組んでから何時間で止めるか */
  hours?: number
  interval_s?: number
}

/** ループの口（組む・止める・再開・いま起こす・片付ける）の応答。片付けたあとは `loop: null` */
export interface LoopResponse {
  id: string
  loop: Loop | null
}

/** `POST /api/agent/loop`（`sai_loop_next`）。エージェントが周の終わりに言う。**動かせるのは自分のループの「次」だけ** */
export interface LoopNextRequest {
  /** 呼んだセッション（MCP の `SAI_ENTITY`） */
  from: string
  action: 'continue' | 'done' | 'give_up'
  /** `continue` のとき、何秒後に起こすか（下限と上限は SAI が丸める。省略は既定の間隔） */
  seconds?: number
  /** `continue` は次の周への申し送り、`done` は根拠、`give_up` は理由 */
  note?: string
}

export interface LoopNextResponse {
  status: LoopStatus
  round: number
  max_rounds: number
  /** `continue` のとき、丸めたあとの秒。上限の周に達していて次が無ければ載せない */
  next_in_s?: number
}

/** `DELETE /api/sessions/<id>/queue/<queue_id>` と `POST /api/sessions/<id>/queue/resume` の応答。いまの預かり */
export interface ReplyQueueResponse {
  id: string
  queue: ReplyQueue
}

/** `GET /api/agent/sessions` の 1 件（#310）。エージェントが話しかけられる相手。本文は載せない */
export interface AgentSessionEntry {
  id: string
  /** 表示名 → 題名 → ID */
  name: string
  project: string
  branch: string
  agent: Agent
  /** 処理中か（送ると預かりに並び、終わってから回る） */
  busy: boolean
  /** 最後の発言の 1 行目（長ければ切ってある） */
  last_text: string
  /** 送ると相手が読み直す量（直近の呼び出しの入力トークン。#311）。分からなければ 0 */
  context_tokens: number
  /**
   * 呼んだセッションの worktree と相手の worktree の**どちらでも変わっているファイル**（#564。先頭 `AGENT_OVERLAP_SHOW` 件）。
   * 同じ箇所を触っていそうなら、着手・マージの前に聞く材料。知らせるだけで、自動では送らない
   */
  overlap: string[]
  /** `overlap` に載せきれなかった数（無ければ 0） */
  overlap_more: number
}

/** `GET /api/agent/sessions?from=` の応答 */
export interface AgentSessionsResponse {
  from: string
  sessions: AgentSessionEntry[]
}

/** `POST /api/agent/send` の body（#310） */
export interface AgentSendRequest {
  /** 送り元のエンティティID（MCP サーバの `SAI_ENTITY`）。SAI から起動して、いまターンを回しているセッションだけ */
  from: string
  /** 送り先。エンティティ ID か、呼び名（表示名・worktree 名・`sessionLabel()`。完全一致。#625） */
  to: string
  text: string
  /**
   * **返答が来たら送り元を起こす**（#594 の 3）。同じターンで `wake` を付けて送ったものが全部返った（か失敗した）ときに、
   * 送り元のターンを 1 回だけ起こして返答を渡す。既定は付けない（返答は次のターンの頭に届く）。起こされたターンからは送れない
   */
  wake?: boolean
  /**
   * 相手に要約（`/compact`）してから始めさせるか（#624）。省略すれば画面からの送信と同じ判定（`shared/compact.ts` の
   * `messageCompacts()`: 本文の 1 行目が着手の形で、相手が要約できるとき）。`true` でも要約できない相手にはそのまま送る
   */
  compact?: boolean
  /**
   * **複数の宛先を 1 つの依頼として送る**（#727）。あれば `to` / `text` は見ない。先に全部の宛先を確かめて読み直す量を数え、
   * 依頼の上限（`AGENT_REQUEST_MAX` 件・`AGENT_REQUEST_READ_BUDGET`）を超えるなら **1 件も送らずに断る**。
   * 収まれば上から順に、1 ターンの回数までその場で送り、残りは預かって送り元のターンが終わってから順に送る。
   * `wake` は全部に掛かる
   */
  items?: { to: string; text: string; compact?: boolean }[]
}

/** `items` で送ったときの 1 件ぶんの結果（#727） */
export interface AgentSendResult {
  message_id: string
  to: string
  to_name: string
  /** その場で送れたときの回し方 */
  via?: ReplyResponse['via']
  /** 預かった（送り元のターンが終わってから送る） */
  held?: true
  context_tokens: number
  /** その場で送ろうとして起動できなかった理由（預かりには回していない） */
  error?: string
}

/** `POST /api/agent/send` に `items` を付けたときの応答（#727） */
export interface AgentSendManyResponse {
  results: AgentSendResult[]
  sent: number
  limit: number
  /** この送り元の預かりの数（この依頼のぶんを含む） */
  held_count: number
  read_tokens: number
  read_budget: number
}

/** `POST /api/agent/send` の応答 */
export interface AgentSendResponse {
  message_id: string
  /** 届いた相手のエンティティ ID（宛先を呼び名で書いたときも、引き当てた id。#625） */
  to: string
  /** 届いた相手の呼び名（`sessionLabel()`。#625。どこに届いたかを取り次ぐ側が人に言えるように） */
  to_name: string
  /** 相手のターンをどう回したか。`queued` なら相手は処理中で、終わってから回る。`compact` なら要約してから本文を回す（#624）。**預かったときは無い** */
  via?: ReplyResponse['via']
  /**
   * 1 ターンの回数（か読み直しの予算）を超えたので、**断らずに預かった**（#727）。送り元のターンが終わってから SAI が順に送る。
   * `message_id` はもう決まっている（返答はいつもどおり画面と次のターンの頭に届く。`sai_wait` では待てない）
   */
  held?: true
  /** この送り元の預かりの数（`held` のとき。この送信を含む） */
  held_count?: number
  /** 送り元のこのターンで送った回数（#311） */
  sent: number
  /** 1 ターンに送れる回数 */
  limit: number
  /** この相手が読み直す量（トークン。#311）。分からなければ 0 で、予算にも足していない */
  context_tokens: number
  /** 送り元のこのターンで、相手に読み直させた量の合計（この送信を含む） */
  read_tokens: number
  /** 1 ターンで相手に読み直させてよい量 */
  read_budget: number
}

/** `GET /api/agent/wait?from=&message_id=` の応答（#310）。`done` なら `text` に相手の返答（長ければ切ってある） */
export interface AgentWaitResponse {
  message_id: string
  to: string
  status: 'done' | 'pending' | 'failed'
  text?: string
  error?: string
}

/** セッションが別のセッションに送ったメッセージ 1 件（画面に出す形。#311） */
export interface AgentActivityMessage {
  message_id: string
  to: string
  /** 相手の呼び名（表示名 → 題名 → ID） */
  to_name: string
  since: string
  /** 相手のそのターンが終わったか。`failed` は相手のターンが失敗した・預かりのまま止まった */
  status: 'pending' | 'done' | 'failed'
}

/**
 * そのセッション（送り元）の、別のセッションへのメッセージのようす（#311）。詳細の応答に、送ったことがあるか止めているときだけ載る。
 * 画面はこれで往復数・読み直させた量・直近の送り先を出し、「送信を止める」を押せる
 */
export interface AgentActivity {
  /** 人が止めている（「再開する」を押すまで送れない） */
  stopped: boolean
  /** いま回しているターンで送った回数（ターンを回していなければ 0） */
  sent: number
  limit: number
  /** いま回しているターンで相手に読み直させた量 */
  read_tokens: number
  read_budget: number
  /** 直近に送ったもの（新しい順、最大 5 件） */
  recent: AgentActivityMessage[]
  /**
   * 預かっている送信（#727。古い順＝送る順）。1 ターンの回数を超えた分で、送り元のターンが終わってから SAI が順に送る。
   * 「送信を止める」で全部捨てる。無ければ省略
   */
  held?: AgentHeldMessage[]
}

/** 預かっている送信 1 件（#727） */
export interface AgentHeldMessage {
  message_id: string
  to: string
  to_name: string
  /** 預かった時刻 */
  at: string
  /** 止まっている理由（自動では送らない。立て直しの前に送りかけていた、など）。無ければ順番待ち */
  halted?: string
}

/** `POST /api/sessions/<id>/agent/stop` と `.../agent/resume` の応答 */
export interface AgentStopResponse {
  id: string
  agent: AgentActivity
  /** 止めたときに取り消した、預かりに並んでいたメッセージの数 */
  cancelled: number
}

/**
 * 返信中のエージェントが人の答えを待っている（ツール実行の許可、AskUserQuestion）。
 * `claude -p` の `--permission-prompt-tool` が SAI の MCP ツール（server/approvals/approve-mcp.ts）を呼び、
 * それが SAI サーバに預けたもの。画面の [許可] [拒否] で答えるまでエージェントは止まっている。
 * 正本はサーバのメモリ（server/approvals/approvals.ts）で、返信のプロセスが exit したら消える
 */
/**
 * 端末で開いている Codex が出しているダイアログの中身（#425）。`capture-pane` した画面から
 * `shared/codexDialog.ts` の `parseCodexDialog()` が組み立てる。**画面は読むだけで出す**
 * （通常起動の TUI にキーを送るのは誤承認になりうるので、答えるのは端末。#208）
 */
export interface TerminalDialog {
  /** 見出しの 1 行（`Would you like to run the following command?`）。画面の上で切れていれば空 */
  title: string
  /** 見出しと選択肢の間の説明（`Environment: local` / `Reason: …`）。無ければ空 */
  detail: string
  /** `$ …` のコマンド全文（複数行のまま）。質問のダイアログでは空 */
  command: string
  /** 番号付きの選択肢。1 つも読めなければダイアログとして扱わない（今までどおりの 1 行に落ちる） */
  options: TerminalDialogOption[]
}
export interface TerminalDialogOption {
  /** 画面に出ている番号（`1.`） */
  number: number
  label: string
  /** いまカーソルが当たっている行（`›` が付いている）。押すとこれが選ばれる */
  selected: boolean
}
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
  /**
   * false は検出専用。SAI から答えを返す安全な経路が無いので、端末で回答する案内だけを出す。端末のダイアログは、
   * 中身が読めなかったときと**半分しか読めなかったとき**（#595。`shared/codexDialog.ts` の `dialogAnswerable()`）
   */
  answerable?: boolean
  /** 端末の画面から読んだダイアログの中身（#425）。読めたぶんをそのまま載せるので、`answerable: false` でも付くことがある。読めなければ省略 */
  dialog?: TerminalDialog
  /** Codex app-server がこのrequestで提示した決定だけ。idから実際のdecisionを引くのはサーバ */
  decisions?: ApprovalDecision[]
  /**
   * 許可して問題なさそうかを Jev で予想した確率（#491。0..1）。**聞いていない・まだ届いていない・聞けなかったときは省略**
   * （`shared/jev.ts`）。設定の `jev_auto`（#499）が入で閾値以上なら、Claude の `-p` の許可はサーバが自動で「常に許可」を返す
   */
  jev?: number
  /**
   * 自動の「常に許可」（#499）で書かれるルールそのものの確率（#553）と、その表記。**自動を入にしていて、Claude の Bash で
   * 聞き終わったときだけ**。この回の確率（`jev`）が高くてもルールは前方一致で広いので低く出ることが多く、
   * 画面に出さないと「90% なのに自動で答えない」理由が見えなかった
   */
  jev_rule?: { label: string; safe: number }
  /**
   * [常に許可] を押すと書かれるルールの表記（#705。`['Bash(pnpm test:*)', 'Bash(pnpm lint:*)']`）。**サーバが組む**（画面は出すだけで送らない）。
   * つないだコマンドは部品ごと（`shared/bashRules.ts`）で、もう設定にあるルールは除いてある。
   * **無ければ [常に許可] を出さない**（Claude の `-p` 以外・ルールを作れないツールやコマンド・全部もう設定にある）
   */
  always?: string[]
  /**
   * この許可が、同じ cwd で同じルールの組（`rulesKey(always)`）の**何回目か**（#445。人が許可した回数 + 1）。
   * Claude の `-p` の許可で、ルールが作れるツールのときだけ。`suggest` は「常に許可」を勧める回数（`APPROVAL_SUGGEST_AT`）に達したか。
   * **勧めるだけ**で、サーバはルールを書かない
   */
  count?: number
  suggest?: boolean
}

/**
 * `<feed dir>/approvals.jsonl` の 1 行（#445 / #582）。SAI の口で許可・質問に**答えたとき**に足す。
 * コマンドの全文や本文は書かない（ルールの表記まで）
 */
export interface ApprovalLogRow {
  /** 答えた時刻（ISO） */
  ts: string
  /** エンティティ ID */
  id: string
  /** そのセッションの cwd（行から。分からなければ空） */
  cwd: string
  tool: string
  /** 書かれるルールの組（`rulesKey()`。`Bash(pnpm test:*) + Bash(tee:*)`）。作れないツール・コマンドは空 */
  rule: string
  /** 誰が答えたか。`jev` は自動の「常に許可」（#499） */
  by: 'human' | 'jev'
  behavior: 'allow' | 'deny'
  /** 「常に許可」で答えた（ルールを書いた） */
  remember: boolean
  /** 預かってから答えるまでの秒数 */
  waited_s: number
  /**
   * `rule` が空だった理由の種類（#724。`rule` があるときは載せない。#724 より前の行には無い）。
   * **種類だけ**で、コマンドの文字・引数・パスは書かない
   */
  no_rule?: NoRuleReason
}

/**
 * [常に許可] のルールが空だった理由の種類（#724）。
 * - Bash の形: `shared/bashRules.ts` の `BashNoRuleReason`（一覧と意味はそちら。最初に当たった 1 つ）
 * - `cd_only`: `cd` しか無く、書くルールが無い
 * - `covered`: 組めたが、全部もう設定の許可のルールにある（ルールがあるのに聞かれている）
 * - `not_bash`: Bash でも MCP でもないツール（Edit / Read / 質問など。もともとルールが無い）
 * 全部の並びは `shared/approvals.ts` の `NO_RULE_REASONS`
 */
export type NoRuleReason = BashNoRuleReason | 'cd_only' | 'covered' | 'not_bash'

/**
 * 画面から答えた許可・質問（#693）。ターンが終わる（次のターン完了の行が来る）まで、セッションの画面に残す。
 * サーバのメモリだけにあり、記録（JSONL）には書かない
 */
export interface AnsweredApproval {
  approval_id: string
  /** 待っていたときに出していた 1 行（`Approval.text`） */
  text: string
  behavior: 'allow' | 'deny'
  /** 答えた時刻（ISO） */
  at: string
  /** 押した選択肢の文言（Codex・OpenCode の「提示された選択」）。無ければ省略 */
  label?: string
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

/** POST /api/approvals の body。MCP ツール（server/approvals/approve-mcp.ts）が送る */
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
  /** 処理中に送って預かっている返信（#305。窓の外のセッションも含む全部）。これが変わると rev も変わる */
  queued: ReplyQueueMap
  /** 組んであるループ（#634。窓の外のセッションも含む全部）。これが変わると rev も変わる */
  loops: LoopMap
  /** 返信中のエージェントが待っている許可・質問（ID → 古い順）。これが変わると rev も変わる */
  approvals: ApprovalMap
  /** 配っている web/dist/ が web/src / shared より古い（git pull のあと pnpm build していない）。これが変わると rev も変わる */
  build_stale: boolean
  /** 窓の中の一番新しい行の v（無い行は 1、行が無ければ 0）。RECORD_VERSION より小さければ記録側の record.py が古い */
  record_version: number
  /**
   * 記録に届いていない Claude Code のフック（#567。`shared/hooks.ts` の `hookGapLabel()` の 1 行ずつ）。空なら出さない。
   * `~/.claude/settings.json` を README のあるべき一覧と突き合わせたもので、分からない（設定が読めない・届くフックが 1 つも
   * 見えない・このマシンの Claude の行が窓に無い）ときも空。rev にも混ぜる（設定を直したら次の行を待たずに消える）
   */
  hooks_missing: string[]
  /**
   * Claude のログインが切れていると分かっている（#685。`claude auth status --json` の `loggedIn: false`）。
   * 聞くのは起動時・Claude の返信が失敗したとき・画面の「確かめ直す」だけ。聞けていない・分からないは false
   */
  claude_logged_out: boolean
  /** 自分の表示名とアイコン。変わると rev も変わる */
  profile: Profile
  /** 誰として見ているか。tailnet 経由（tailscale serve）ならログイン名、ローカルの直アクセスなら null */
  viewer: Viewer | null
  /**
   * このサーバが動いているマシンの名前（`AGENT_FEED_HOST` か `os.hostname()` の短い形。記録側の `host` と同じ変数・同じ規則。#114 / #288）。
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
  /** そのセッションの行。`recent=<日数>` を付けると一番新しい行から数えて直近のぶんだけ（#477。`shared/recentRows.ts`） */
  rows: FeedRow[]
  /** `recent` で落とした、それより前の行の数（窓の中）。付けていなければ 0 */
  older: number
  /** 落とした行の人の入力（新しい順、`OLDER_PROMPTS_MAX` まで）。描かない行の入力も ↑ の履歴で呼び戻すため */
  older_prompts: string[]
  replying: ReplyingMap
  /** 預かっている返信（#305。SessionsResponse と同じ） */
  queued: ReplyQueueMap
  /** 組んであるループ（#634。SessionsResponse と同じ） */
  loops: LoopMap
  /** そのセッションから別のセッションへのメッセージのようす（#311）。送ったことがあるか止めているときだけ */
  agent?: AgentActivity
  /** 返信中のエージェントが待っている許可・質問（ID → 古い順）。これが変わると rev も変わる */
  approvals: ApprovalMap
  /** このセッションで、いまのターンの間に画面から答えた許可・質問（#693。古い順）。無ければ省略。変わると rev も変わる */
  answered?: AnsweredApproval[]
  /** 自分の表示名とアイコン。変わると rev も変わる */
  profile: Profile
  /** このサーバのマシン名（SessionsResponse と同じ。#114）。セッション画面は一覧を持たないのでここにも載せる */
  host: string
  /**
   * 端末で開いた Claude が答えを待っている質問の中身（#333）。行の待ち（`session.waiting`）が質問で、transcript の返事の付いていない
   * `AskUserQuestion` が同じ文のときだけ。SAI が回している `claude -p` の質問は `approvals` に出るので載せない
   */
  question?: PendingQuestion
  /** `claude --bg` のセッションなら、端末で開くための短い ID と状態（#462） */
  background?: BackgroundSession
  /**
   * このセッションが別のセッションに送ったメッセージへの返答（#588）。相手のターン完了の行に `agent_reply` を付けたもの（古い順）。
   * 送り元が `sai_wait` せずにターンを終えても、返答がこの画面に出る。描いている窓（`recent`）より前の返答は載せない
   */
  agent_replies?: FeedRow[]
  /** 人がこの画面の返答のバブルの下から相手へ送った返信（#700。古い順）。バブルの下の 1 行に出す */
  agent_followups?: AgentFollowupLine[]
  /**
   * `agent_replies` の相手のセッション（#700。その場で返信する入力欄・返信できるかの判定・案 `next_ask` に使う）。
   * セッション画面は一覧を持たないのでここに載せる。一覧の窓の外の相手は載らない（そのときは返信の口を出さない）
   */
  agent_reply_sessions?: SessionSummary[]
  /**
   * いまのコンテキスト量（#441。返信 1 回で読み直す量）。`ProgressReader.read()` の `context_tokens` で、分からない
   * （別のマシン・読めない・サーバの立っていない OpenCode）ときは載せない
   */
  context_tokens?: number
}

export interface FeedResponse {
  rev: string
  days: number
  rows: FeedRow[]
  replying: ReplyingMap
  /** 預かっている返信（#305。SessionsResponse と同じ） */
  queued: ReplyQueueMap
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
  /**
   * 前の返信を処理中なら 409 にせず預かる（#305。応答は `202` で `via: 'queued'`）。前のターンが終わったら
   * サーバが古い順に 1 件ずつ回す。処理中でなくても、そのセッションに預かりが残っていれば後ろに並べる
   * （先に預けたものを追い越さない）。省略すれば今までどおり、処理中は `409`
   */
  queue?: boolean
  /**
   * **走っているターンに足す**（#404。Codex の `turn/steer`）。付いていなければ今までどおり預かり（`queue`）か `409` で、
   * 付いていても足せなければ（ターンが終わっていた・別のターンになった）そちらに落ちる。
   * 預かりと違って**取り消せない**（走っているターンの筋がその場で変わる）ので、画面は選んだときだけ付ける
   */
  steer?: boolean
  /**
   * **要約（`/compact`）してから送る**（#579）。サーバは本文を預かり（#305）の先頭に置き、`/compact <残すものの指示>` の
   * ターンを起こす。要約が終わったら預かりが本文を回し、要約が失敗したら預かりは止まる（「続けて送る」で要約せずに送る）。
   * 効くのは Claude で、端末で開いておらず、処理中でも預かりが残ってもいないときだけ。それ以外は付いていないのと同じ
   */
  compact?: boolean
  /**
   * 別のセッション（送り元）の画面の、返答のバブルの下から送った（#700）。**送り方は変えない**（人の返信のまま）。
   * サーバは「送り元がこの相手にメッセージを送ったことがある」ときだけ覚えて、送り元の画面に小さい 1 行と
   * 相手のそのあとの返答を出す。`anchor` はどのバブルの下か（その行の `ts`）で、表示にしか使わない
   */
  sent_from?: { id: string; anchor: string }
}

/** POST /api/sessions/<id>/attachments?name=。body はファイルそのもの（画像・文字のファイル・PDF。#608） */
export interface AttachmentResponse {
  id: string
  /** 返信の `attachments` に入れる絶対パス */
  path: string
  /** <img src> に使う URL。**画像だけ**（ほかのファイルは配らないので空） */
  url: string
  mime: string
  size: number
  /** 中身から決めた種類 */
  kind: 'image' | 'text' | 'pdf'
  /** 元のファイル名を出せる形にしたもの（画像と、名前の無いものは空） */
  name: string
}

/**
 * 返信の 409 の body。`error` は今までどおり人向けの文。`code` があれば画面が出し分けられる:
 * - terminal_typed: 端末の入力欄に打ちかけの文字がある（`typed` にその文）。消して送るかを確認できる
 * - terminal_dialog: 端末が許可や質問のダイアログを出している（消させない）
 * - terminal_unknown: 入力欄が見つからない（別のプログラムに打ち込まない）
 */
export interface ReplyError {
  error: string
  code?: 'terminal_typed' | 'terminal_dialog' | 'terminal_unknown' | 'head_moved' | 'lines_moved'
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

/**
 * `POST /api/sessions/<id>/fork` の本文（#405）。Codex のセッションを会話ごと分岐して、分岐先で最初の 1 ターンを回す。
 * **`cwd`・モデル・権限はリクエストから受けない**（元のセッションのまま）。応答は `NewSessionResponse`
 */
export interface ForkSessionRequest {
  /** 分岐先に最初に送る指示。分岐だけして何も送らない形は無い */
  text: string
}

/**
 * 差分のレビューを頼むときの対象（#403）。Codex の app-server の `review/start` の `target` に対応する。
 * 画面の差分ビューアが出している 2 つの区切りと同じで、`commit` / `custom` は画面から選ぶ材料が無いので出さない
 */
export type ReviewTarget = 'uncommittedChanges' | 'baseBranch'

export interface ReviewRequest {
  target: ReviewTarget
}

export interface ReviewResponse {
  accepted: true
  id: string
  session: string
  cwd: string
  target: ReviewTarget
  /** `baseBranch` のときに比べた相手（差分ビューアと同じ選び方） */
  base?: string
}

export interface ReplyResponse {
  accepted: true
  id: string
  agent: Agent
  /**
   * terminal: tmux。process: 非対話CLI。queue: 開いているCodex。app-server: SAI管理のCodex。
   * queued: 処理中だったので預かった（まだ起動していない。#305）
   */
  via: 'terminal' | 'process' | 'queue' | 'app-server' | 'queued' | 'steer' | 'compact'
  /** via が queued / compact のとき、預かった返信の id（取り消しに使う。compact は要約のあとに回る本文） */
  queue_id?: string
  /** 送り方についての一言（#678。開いている Codex に画像を添えたとき）。画面が入力欄の上に出す */
  note?: string
  session: string
  cwd: string
}

/**
 * POST /api/sessions/new。SAI の画面から新しいセッションを始める（#314。Codex は #401）。
 * **作業ディレクトリは受け取らない**: `from`（既存のセッションのエンティティID）の `cwd` をサーバが使う
 * （返信と同じく、ブラウザから任意の場所でコマンドを走らせない）。`cwd` を送っても見ない
 */
export interface NewSessionRequest {
  /** どの worktree で始めるか。そこで記録されたことのあるセッションの ID */
  from: string
  /**
   * `from` と同じリポジトリの、記録の無い兄弟 worktree で始めるとき（#319）の鍵（`GET /api/workspaces` の `worktree`）。
   * **パスではない**: サーバが `from` の cwd で `git worktree list` を読み直し、その中に同じ鍵があるときだけ通す。
   * 省略は `from` の cwd で始める
   */
  worktree?: string
  text: string
  /**
   * どのエージェントで始めるか（#401。OpenCode は #452）。省略は `claude`。
   * **Grok だけは ID を先に決める口が無いので選べない**
   */
  agent?: 'claude' | 'codex' | 'opencode'
  /** 返信のモデル（省略・空は CLI の既定）。検査して新しいセッションのメタに書く */
  model?: string
  /** 返信の許可モード（`REPLY_MODES` のどれか。省略・空は CLI の既定）。検査して新しいセッションのメタに書く */
  permission_mode?: string
  /**
   * `claude --bg` で始める（#462。Claude だけ）。あとから端末で `claude attach <短い ID>` して開ける。
   * **許可・質問は画面では答えられない**（`--permission-prompt-tool` が使われない）ので、端末で attach して答える
   */
  background?: boolean
  /**
   * `from` のセッションの**表示名・アイコン・一言の性格を引き継ぐ**（#579 の「新しいセッションで送る」）。
   * 前のセッションは消さず、アーカイブもしない
   */
  inherit?: boolean
  /**
   * **引き継いで始める**（#442。Claude だけ）。最初の入力は `text` ではなく、**サーバが `from` の最後のターン完了の行から取る**
   * （その入力が引き継ぎの依頼文 `shared/handoff.ts` の `HANDOFF_PROMPT` のときだけ。違えば `409`）。`text` は見ない。
   * 表示名・アイコン・一言の性格（`inherit`）に加えて、モデルと許可モードも `from` のメタから引き継ぎ、
   * 新しい方に `continued_from`、前の方に `continued_to` を書く
   */
  handoff?: boolean
}

/** 記録の無い兄弟 worktree 1 つ（#319）。`from` は同じリポジトリの、記録のある一番新しいセッション */
export interface SiblingWorktree {
  from: string
  /** `NewSessionRequest.worktree` に入れる鍵 */
  worktree: string
  cwd: string
  /** worktree 名（toplevel の basename。record.py の `repo` と同じ） */
  repo: string
  branch: string
  project: string
}

/**
 * `GET /api/workspaces`（#319）。新しいセッションを始められる場所。`recorded` は記録にある cwd のうち
 * **git の作業ツリーの中にあるもの**の、その cwd で一番新しいセッションの ID（`/`・`/tmp`・scratchpad は入らない）
 */
export interface WorkspacesResponse {
  recorded: string[]
  siblings: SiblingWorktree[]
}

export interface NewSessionResponse {
  accepted: true
  /** 新しいセッションのエンティティID（`<uuid>@<repo>`）。最初の行が届けば一覧に出る */
  id: string
  agent: Agent
  /**
   * Claude は CLI に渡した `--session-id`、Codex は `thread/start` が返した thread id（#401）、
   * OpenCode は `POST /session` が返した `ses_…`（#452）
   */
  session: string
  cwd: string
  via: 'process' | 'app-server' | 'background'
  /** `claude --bg` で始めたとき（#462）の短い ID。`claude attach <これ>` で端末に開ける */
  attach?: string
}

/**
 * `claude --bg` で動いている（動いていた）セッション（#462）。`claude agents --json --all` の行から。
 * 止めたもの（`live: false`）も `claude attach` で起こし直せるので出す
 */
export interface BackgroundSession {
  /** `claude attach` に渡す短い ID */
  attach: string
  /** デーモンの中でいま生きているか */
  live: boolean
  /**
   * CLI が返す状態をそのまま（版で語が違う。#462）。2.1.278 は `working` / `stopped` / `done`、
   * 2.1.276 は `busy` / `idle` / `waiting` で、止めたものは空。
   * **`live` と違って、いまターンが回っているかは分からない**（2.1.278 の `working` は「生きている」だけ）
   */
  status: string
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
 * 一言はサーバが作るので設定もサーバに持つ。一言の入切・口・モデルも PUT で変わる（#288。前は環境変数で、立て直すたびに打っていた）。
 * **本文の送り先（`SAI_DIGEST_URL`）と鍵（`SAI_DIGEST_API_KEY`）は環境変数のままで、ここには載せない**（画面から外へ向けられないように）
 */
export interface SettingsResponse {
  persona: PersonaId
  /** 一言をいま作っているか（入にしていて、口が組めた）。性格・Linear の欄はこれが true のときだけ出す */
  digest: boolean
  /** 一言を入にしているか（settings.json の `digest`）。入なのに `digest` が false なら `digest_error` に理由がある。`digest` が true でも、口が続けて失敗していれば `digest_error` に出る（#443） */
  digest_on: boolean
  /** 入なのに作れない理由（openai の口でモデルが空など）。無ければ空 */
  digest_error: string
  /** 次に送る文面の案をいま作っているか（#560。入にしていて、口が組めた）。一言と同じ口・同じモデルを使う */
  next_ask: boolean
  /** 案を入にしているか（#560。settings.json の `next_ask`。無いときは `digest` に従う） */
  next_ask_on: boolean
  /** 一言を作る口。claude は `claude -p`、openai は OpenAI 互換の HTTP（Ollama / LM Studio など） */
  provider: DigestProvider
  /** 保存しているモデル名。空は口の既定 */
  digest_model: string
  /** 実際に使うモデル（`digest_model` が空なら口の既定。openai には既定が無いので空） */
  model: string
  /** Linear の workspace（URL の linear.app/<workspace>/ の部分）。一言の中の ABC-123 のような識別子のリンク先。空なら組まない */
  linear_workspace: string
  /** 許可を Jev で予想するか（#491。settings.json の `jev`。既定は入） */
  jev_on: boolean
  /** Jev に送れるか（サーバの環境に `JEV_API_KEY` があるか）。無ければ入でも何も送らない */
  jev_ready: boolean
  /** Jev の確率がこれ以上なら自動で「常に許可」する閾値（#499。0 = しない。既定 0）。Claude の `-p` の許可だけ */
  jev_auto: number
  /** 入力欄への長い貼り付けをファイルにして添えるか（#609。settings.json の `paste_to_file`。既定は切） */
  paste_to_file: boolean
  /**
   * 返信の既定の許可モード（#582。settings.json の `reply_mode`）。セッションのメタに許可モードが無いときだけ使う。
   * `REPLY_MODES` のどれかで、空は「決めない」（CLI の既定）
   */
  reply_mode: ReplyPermissionMode | ''
}

/** 一言を作る口。`claude`（`claude -p`。既定）か `openai`（OpenAI 互換の `/v1/chat/completions`。ローカルの LLM はこちら） */
export type DigestProvider = 'claude' | 'openai'

/** PUT /api/settings の body。省略したキーは据え置き */
export interface SettingsRequest {
  persona?: PersonaId
  /** 空文字で「設定なし」に戻す */
  linear_workspace?: string
  /** 一言を作るか */
  digest?: boolean
  /** 次に送る文面の案を作るか（#560。一言とは別に入切する） */
  next_ask?: boolean
  /** 一言を作る口 */
  digest_provider?: DigestProvider
  /** 一言を作るモデル。空文字で「口の既定」 */
  digest_model?: string
  /** 許可を Jev で予想するか（#491） */
  jev?: boolean
  /** 自動で常に許可する閾値（#499）。0 で「しない」、それ以外は 0.5〜1 */
  jev_auto?: number
  /** 入力欄への長い貼り付けをファイルにして添えるか（#609） */
  paste_to_file?: boolean
  /** 返信の既定の許可モード（#582）。`REPLY_MODES` のどれか。空文字で「決めない」 */
  reply_mode?: ReplyPermissionMode | ''
}

export interface SessionFilters {
  /**
   * リポジトリ（`Naturalclar/sai`）。主軸。**複数選べる**（#529。空ならすべて、選んだどれかに当たれば出す）。
   * クエリには `project` を繰り返して載せる（`?project=a&project=b`）
   */
  projects: string[]
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
  /** リポジトリ（`Naturalclar/sai`）。サイドバーの絞り込みに従う（複数。#529） */
  projects: string[]
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
export type ReplyPermissionMode = 'acceptEdits' | 'auto' | 'bypassPermissions'

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
  /** よく許可しているが、許可のルールに無いもの（#445。多い順）。無ければ省略 */
  frequent?: { rule: string; count: number }[]
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

/** セッションに出てきた画像の 1 枚（#504。`shared/gallery.ts`） */
export interface GalleryItem {
  /** `<img src>` に使う URL（サーバが配る口） */
  url: string
  /** 画像の名前（ファイル名か、transcript の画像なら `貼った画像` など） */
  name: string
  /** 出てきた時刻（ISO）。並べる順に使う */
  at: string
  /** 飛び先の行の `ts`（`#/s/<id>?ts=`）。当てられなければ空 */
  ts: string
  /** 誰の発言に出てきたか */
  from: 'user' | 'agent'
  /** どこから拾ったか（`generated` は Codex の画像生成で作った画像。#575。`viewed` は Codex が `view_image` で見せた cwd の中の画像。#704） */
  source: 'text' | 'attachment' | 'transcript' | 'generated' | 'viewed'
}

/**
 * `GET /api/sessions/<id>/turn?ts=` の応答（#537）。そのセッションの、`ts` のターン完了の行（無ければ null）。
 * 要対応の「終了」の行で、一言（要約）のもとになった本文を開くときに使う（一覧の `last_text` は 1 行目の 120 字だけ）
 */
export interface SessionTurnResponse {
  id: string
  row: FeedRow | null
}

/** 終わったターンの 1 手順（#605）。ツールの呼び出しと、途中で書いた文（#680）。ツールの出力は載せない */
export interface TurnStep {
  /** ツール名（`Bash` / `Edit` / `exec_command` …）。途中の文（`text` がある）では空 */
  tool: string
  /** 途中でエージェントが書いた文（#680。2000 字まで）。あればこの手順はツールの呼び出しではない */
  text?: string
  /** 何をしたか（コマンド・ファイルのパス・URL など。許可のバブルと同じ要約。300 字まで）。分からなければ空 */
  summary: string
  /** Bash などの `description`（何のためか）。あれば */
  note?: string
  /** 呼んだ時刻（ISO） */
  at: string
}

/**
 * `GET /api/sessions/<id>/turn-steps?ts=` の応答（#605）。`ts` のターン完了の行のターンで呼んだツール（古い順）。
 * **開いたときに 1 回だけ**取る（ポーリングには乗せない）。`found: false` は「記録がありません」
 * （transcript / rollout が無い・そのターンが引けない・別のマシン・OpenCode）
 */
export interface TurnStepsResponse {
  id: string
  ts: string
  found: boolean
  /** 多ければ頭の `TURN_STEPS_MAX` 件。途中の文（`text`。#680）も時刻順に混ざる */
  steps: TurnStep[]
  /** そのターンで呼んだツールの数（途中の文は数えない） */
  total: number
  /** steps に入り切らなかった数（ツールと途中の文の合計）。無ければ省く */
  more?: number
}

/** GET /api/sessions/<id>/gallery。そのセッションに出てきた画像（新しい順）。開いたときと新しいターンが記録されたときだけ取る */
export interface GalleryResponse {
  id: string
  items: GalleryItem[]
}

/** 使用量の画面（#602）の合計。トークンは 1 ターンぶんの足し算、費用は API 換算の目安（セッションの積み上げとの差で数える） */
export interface UsageTotals {
  /** SAI が起こしたターンの数（turn-usage.jsonl の行の数） */
  turns: number
  input_tokens: number
  output_tokens: number
  /** 読み直し（キャッシュ読み） */
  cache_read_input_tokens: number
  /** キャッシュ書き */
  cache_creation_input_tokens: number
  /** 4 つの合計 */
  tokens: number
  /** API 換算の目安（USD）。定額プランでは実際に請求されるものではない */
  cost_usd: number
  /** 未許可で断られたツールの数 */
  denials: number
  /** エラーで終わったターンの数 */
  errors: number
}

/** 使用量の表の 1 行（日別・モデル別）。`key` は日付（Asia/Tokyo の YYYY-MM-DD）かモデル名（分からなければ空） */
export interface UsageReportRow extends UsageTotals {
  key: string
  /** 全体のトークンに占める割合（0〜1） */
  token_share: number
  /** 全体の費用に占める割合（0〜1） */
  cost_share: number
}

/** セッション別の 1 行。`key` はエンティティ ID */
export interface UsageSessionRow extends UsageReportRow {
  /** 呼び名か題名。記録に見つからなければ無い（画面は ID を出す） */
  name?: string
  /** モデルを 1 回呼ぶたびに読み直した量の平均（読み直し ÷ CLI の中で回ったターン数） */
  read_per_call: number
  /** 読み直しが大きい（コンテキストの注意 #441 と同じ区切り） */
  heavy: boolean
}

/** `GET /api/usage/report?days=`（#602）。SAI が起こした Claude のターンだけ（端末で回したぶん・Codex・OpenCode は入らない） */
export interface UsageReportResponse {
  /** 期間（日） */
  days: number
  /** 数えはじめの時刻（ISO） */
  since: string
  total: UsageTotals
  /** トークンの多い順 */
  sessions: UsageSessionRow[]
  /** 新しい日から */
  by_day: UsageReportRow[]
  /** トークンの多い順 */
  by_model: UsageReportRow[]
}
