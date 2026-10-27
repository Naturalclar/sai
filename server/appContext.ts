// `createApp()`（app.ts）が持つ共有の値の入れ物（#807）。区分ごとのファイル（`server/reply/loopRoutes.ts` など）は
// `create…(ctx)` でこれを受け取り、口の処理・時計の 1 回ぶんを返す。
//
// - **持ち主は `createApp()` のまま**: 店・処理中・預かり・起動中の印などは `createApp()` が作り、ここには参照を入れるだけ（写しを作らない）
// - **初期化の順番も `createApp()` のまま**: `create…(ctx)` は関数を作るだけで、時計を立てる・ファイルを読むなどの副作用を持たない
// - 循環 import を作らない: このファイルと区分のファイルは `app.ts` を import しない（型もここか `shared/` に置く）
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Replying, ReplyError, ReplyResponse, SessionMeta, SessionSummary } from '../shared/types.ts'
import type { UsageStore } from './local/usage.ts'
import type { MetaStore } from './meta/meta.ts'
import type { CodexApp } from './reply/codexAppServer.ts'
import type { LoopStore } from './reply/loops.ts'
import type { OpencodeApp } from './reply/opencodeServer.ts'
import type { ReplyQueueStore } from './reply/replyQueue.ts'
import type { Runner } from './reply/runner.ts'
import type { TerminalReplies } from './reply/terminal.ts'
import type { FeedStore } from './rows/store.ts'

/** 預かった返信を起動するときに見る窓（POST の reply の既定と同じ） */
export const QUEUE_DAYS = 90

/** 返信 body の上限。指示文なので十分 */
export const MAX_REPLY_BYTES = 64 * 1024

/** 返信を 1 本起動するときの指定。`POST .../reply` と、預かった返信を回す drain の両方が作る（#305） */
export interface LaunchOptions {
  days: number
  replaceTyped: boolean
  forceProcess: boolean
  /** 許可・質問を画面で答える MCP の宛先（このサーバ自身。`selfUrl()`） */
  url: string
  /** 処理中なら預かる（`ReplyRequest.queue`） */
  queue: boolean
  /** 別のセッションから送られたメッセージなら、その message_id（#310）。起動したターンから先へは送らせない（連鎖 1 段） */
  origin?: string
  /** 走っている Codex のターンに足す（#404。`ReplyRequest.steer`）。足せなければ今までどおり預かりか 409 */
  steer?: boolean
  /** 要約してから送る（#579。`ReplyRequest.compact`）。startTurn では「このターンは要約だけ」の印 */
  compact?: boolean
  /**
   * `/compact` に添える指示を作る元の文（#624）。メッセージは本文の頭に見出し（【SAI】…）が付くので、送り元が書いた文を別に渡す。
   * 無ければ本文から
   */
  compactFrom?: string
  /** ループの周として SAI が起こすターン（#634）。MCP に `sai_loop_next` を出す */
  loop?: boolean
  /** `claude --bg` との競合を受けて起こし直した 1 回。もう同じ失敗で再試行しない（#798） */
  backgroundRetried?: boolean
  /**
   * 別のセッション・tailnet の MCP から届いたメッセージ（#800）。端末で開いている Claude に打ち込めなかったとき
   * （打ちかけ・ダイアログ・読めない = `can_process` の 409）は、断らずに預かって止め、送り元と要対応に出す（自動では別プロセスへ回さない）。
   * 人が「続けて送る」を押した 1 回だけ別プロセスで回す。人の画面からの返信には付けない
   */
  terminalFallback?: boolean
}

/** 起動の結果。HTTP には書かずに返すので、POST はそのまま応答にし、drain は預かりを止める理由にする */
export interface Launched {
  status: number
  body: ReplyResponse | ReplyError
  /**
   * `claude --bg` のセッションがターンを回している・許可を待っているので送らなかった（#462）。
   * 預かりを回す `drain()` は**止めずに次の機会を待つ**（SAI の外で動いているので、終わりを知らせる口が無い）
   */
  retry?: boolean
}

/** `createApp()` の中の値のうち、区分のファイルが使うもの。どれも `createApp()` が作ったものへの参照 */
export interface AppContext {
  // ---- 店・状態（持ち主は createApp()）
  store: FeedStore
  /** セッションに組んだループ（#634） */
  loops: LoopStore
  /** 処理中の返信（プロセス） */
  run: Runner
  /** 起動中の印（`launch()` が立てて下ろす） */
  launching: Set<string>
  /** 端末に打ち込んだ返信 */
  typed: TerminalReplies
  /** 預かり（#305） */
  queue: ReplyQueueStore
  codexApp: CodexApp
  opencodeApp: OpencodeApp
  metaStore: MetaStore
  usageStore: UsageStore
  // ---- 時計（テストでは進める・止める）
  loopNow: () => number
  /** ループを見に行く間隔。0 ならタイマーを立てない（テスト） */
  loopTickMs: number
  // ---- createApp() の中の関数
  launch: (id: string, text: string, attachments: string[], o: LaunchOptions) => Promise<Launched>
  sessionsWithMeta: (days: number) => Promise<{ rev: string; sessions: SessionSummary[] }>
  failedReply: (id: string) => Replying | undefined
  replyMode: (meta: Pick<SessionMeta, 'permission_mode'> | undefined | null) => Promise<string>
  terminalOf: (s: SessionSummary, o?: { soft?: boolean }) => Promise<{ pane: string; pid: number } | null>
  agentRefusal: (req: IncomingMessage) => string
  agentFrom: (from: unknown) => Promise<{ session: SessionSummary; sessions: SessionSummary[]; turn: string } | string>
  // ---- HTTP の小物（app.ts のものをそのまま渡す）
  json: (res: ServerResponse, payload: unknown, status?: number) => void
  error: (res: ServerResponse, status: number, message: string) => void
  readJson: (req: IncomingMessage, limit: number) => Promise<unknown>
  isCrossOrigin: (req: IncomingMessage) => boolean
  selfUrl: (req: Pick<IncomingMessage, 'socket'>) => string
}
