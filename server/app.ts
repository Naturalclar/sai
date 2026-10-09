// ルーティング。main.ts が node:http に載せ、テストは createApp() を直接叩く。
import { createHash, randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { appendFile, readFile, realpath, stat } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { basename, extname, join, resolve, sep } from 'node:path'
import { historyIconUrl, ICON_MAX_BYTES, ICON_MIME, iconUrl, sniffImageType } from '../shared/icon.ts'
import type { IconType } from '../shared/icon.ts'
import { ATTACHMENT_MAX_BYTES, ATTACHMENT_MAX_COUNT, ATTACHMENTS_DIR, isImageAttachmentPath, QUEUE_IMAGE_NOTE, withAttachments } from '../shared/attachments.ts'
import { isArchivedAt, mergeMeta, META_NAME_MAX } from '../shared/meta.ts'
import { mergeProfile, PROFILE_ICON_ID, profileIconUrl } from '../shared/profile.ts'
import { isPersonaId } from '../shared/persona.ts'
import { canSteer, replyBlockedReason, replyFailureText } from '../shared/reply.ts'
import { canCompact, compactPrompt, messageCompacts } from '../shared/compact.ts'
import { handoffFirstText, handoffReady } from '../shared/handoff.ts'
import { selfHost } from './host.ts'
import type { SessionTurnResponse, TurnStepsResponse,
  AgentActivity,
  AgentFollowupLine,
  AgentHeldMessage,
  SendAcrossPair,
  PrSummary,
  SessionHolding,
  AgentSendManyResponse,
  AgentSendResult,
  AgentActivityMessage,
  AgentStopResponse,
  AgentSendRequest,
  AgentSendResponse,
  AgentSessionsResponse,
  AgentWaitResponse,
  Approval,
  ApprovalAnswer,
  GalleryItem,
  GalleryResponse,
  ApprovalMap,
  NoRuleReason,
  PermissionRule,
  PermissionUpdate,
  ApprovalRequest,
  AttachmentResponse,
  FeedResponse,
  FeedRow,
  HealthResponse,
  NewSessionRequest,
  SiblingWorktree,
  WorkspacesResponse,
  NewSessionResponse,
  Profile,
  ProfileResponse,
  ReplyError,
  Replying,
  ReplyingMap,
  LoopNextRequest,
  LoopNextResponse,
  LoopResponse,
  WaitActionRequest,
  WaitActionResponse,
  WaitForRequest,
  WaitForResponse,
  ReplyQueueResponse,
  ReplyRequest,
  ReplyResponse,
  SessionDetailResponse,
  BackgroundSession,
  SessionDiffResponse,
  SessionFileResponse,
  SessionDiffSummaryResponse,
  SessionProgressResponse,
  SessionTodo,
  SessionIconResponse,
  IconHistoryResponse,
  SessionMetaResponse,
  ReadRequest,
  ReadResponse,
  ManagerDraft,
  SuggestionActionRequest,
  SuggestionActionResponse,
  SessionPermissionsResponse,
  SessionModelsResponse,
  SessionSkillsResponse,
  SearchResponse,
  PrDetailResponse,
  PrReviewResponse,
  PrRepo,
  PrsResponse,
  SessionsResponse,
  ForkSessionRequest,
  ReviewRequest,
  ReviewResponse,
  SessionMeta,
  SessionSummary,
  SettingsRequest,
  SettingsResponse,
  ClaudeAuthCheckResponse,
  ClaudeLoginRequest,
  UsageReportResponse,
  UsageResponse,
  Viewer,
} from '../shared/types.ts'
import { clip, entityId, facets, filterSessions, firstLine, recordVersionOf } from './rows/aggregate.ts'
import { rowProject } from '../shared/project.ts'
import { cleanProjects, matchesProjects } from '../shared/projectFilter.ts'
import { ICONS_DIR, IconStore, iconKey } from './meta/icons.ts'
import { historyKey, ICON_HISTORY_DIR, ICON_HISTORY_FILE, IconHistory, isHistoryKey } from './meta/iconHistory.ts'
import { alwaysAllowPlan, ruleLabel } from '../shared/approvals.ts'
import { APPROVAL_SUGGEST_AT, ruleCovered, rulesKey } from '../shared/approvalCounts.ts'
import { APPROVAL_LOG_FILE, ApprovalLog } from './approvals/approvalLog.ts'
import { APPROVALS_FILE, Approvals, WAIT_MS } from './approvals/approvals.ts'
import { BuildFreshness } from './local/buildFreshness.ts'
import { NoClaudeHooks, type ClaudeHooksReader } from './local/claudeHooks.ts'
import { NoClaudeAuth, type ClaudeAuthReader } from './local/claudeAuth.ts'
import { NoClaudeLogin, loginCode, type ClaudeLoginRunner } from './local/claudeLogin.ts'
import { codexLockHolders, codexQueueCommand, codexWriterActive, isAppServer, runCodexQueue } from './reply/codex.ts'
import type { CodexQueue } from './reply/codex.ts'
import { CodexAppServer } from './reply/codexAppServer.ts'
import type { CodexApp } from './reply/codexAppServer.ts'
import { OPENCODE_SERVE_FILE, OPENCODE_SERVE_LOG, OpencodeServer } from './reply/opencodeServer.ts'
import type { OpencodeApp } from './reply/opencodeServer.ts'
import { OpencodePermissions } from './reply/opencodePermissions.ts'
import { approvalMapKey, CodexDialogs, DIALOG_SCAN_TTL_MS, mergeApprovalMaps } from './reply/codexDialogs.ts'
import { JevRisk } from './approvals/jev.ts'
import { isJevAuto, jevAutoAllows, jevAutoDecision, jevAutoEligible, jevLowestRule, jevPercent, jevRuleState } from '../shared/jev.ts'
import type { JevJudge } from './approvals/jev.ts'
import { CodexTerminals, type CodexTerminalSource } from './reply/codexTerminal.ts'
import { CodexPanes, codexAppServer, type AppServerProbe, type CodexPaneSource } from './reply/codexPanes.ts'
import { screenWait } from './reply/softWait.ts'
import { clearSettled, settledKey, WaitingSettle } from './reply/waitingSettle.ts'
import type { WaitingSettleSource } from './reply/waitingSettle.ts'
import type { CodexDialogSource, DialogTarget } from './reply/codexDialogs.ts'
import { DIGEST_FILE, DigestStore, createDigester } from './digest/digest.ts'
import { FEEDBACK_FILE, FeedbackStore } from './digest/feedback.ts'
import { DIGEST_NOTE_MAX, isDigestFeedbackReason, isDigestUsageReason } from '../shared/digestFeedback.ts'
import type { DigestFeedbackRequest, DigestFeedbackResponse } from '../shared/digestFeedback.ts'
import { isDigestModel, isDigestProvider } from '../shared/digestSettings.ts'
import type { Digester } from './digest/digest.ts'
import { META_FILE, MetaStore } from './meta/meta.ts'
import { collectPermissions } from './approvals/permissions.ts'
import { isReplyPermissionMode, modeName, modeSkipsRules, REPLY_MODES, replyModeOf, skipModeInArgs } from '../shared/permissions.ts'
import { compareUrl, parseUnifiedDiff } from '../shared/diff.ts'
import { changedPaths, clampPatch, NotAGitRepo, RealGit, resolveBase, sessionDiff, sessionDiffSummary } from './git/diff.ts'
import { prBrowserFromEnv } from './git/prs.ts'
import type { PrBrowser } from './git/prs.ts'
import { diffStats, githubRepoOf, isPrNumber, knownRepos, pickKnownRepo } from '../shared/prs.ts'
import { addPair, mayCross, removePair } from '../shared/sendAcross.ts'
import { holdingLabel, holdingOf } from '../shared/holding.ts'
import { githubReview, parseReviewRequest } from '../shared/prReview.ts'
import { fillRepo, ProjectResolver } from './git/project.ts'
import type { Git } from './git/diff.ts'
import { prLookupFromEnv } from './git/pr.ts'
import type { PrLookup } from './git/pr.ts'
import { AttachmentStore } from './reply/attachments.ts'
import { PROFILE_FILE, ProfileStore } from './meta/profile.ts'
import { READ_MARKS_FILE, ReadStore } from './meta/reads.ts'
import { SUGGESTIONS_FILE, SuggestionStore } from './mcp/suggestions.ts'
import { liveManagerDraft } from '../shared/managerDraft.ts'
import { stopMissing, stopMissingCandidate } from '../shared/stopMissing.ts'
import { RecoveredTurns } from './local/recovered.ts'
import { TURN_STEPS_MAX, findStepTurn } from '../shared/turnSteps.ts'
import { readMarkOf, rowMs, unreadCounts, unreadFromMark } from '../shared/unread.ts'
import { SETTINGS_FILE, SettingsStore, nextAskOn } from './meta/settings.ts'
import type { Settings } from './meta/settings.ts'
import { isLinearWorkspace } from '../shared/refs.ts'
import { backgroundSessionCommand, newSessionCommand, ProcessRunner, replyCommand, splitArgs } from './reply/runner.ts'
import { ClaudeLimitsFile, replyLimitsFile } from './reply/claudeLimits.ts'
import { BackgroundLookupError, ClaudeBackground, type BackgroundSessions } from './reply/claudeBackground.ts'
import { TURN_USAGE_FILE, TurnUsageLog } from './reply/turnUsage.ts'
import { usageReport, usageReportDays } from '../shared/usageReport.ts'
import { QUEUE_FILE, QUEUE_MAX, ReplyQueueStore } from './reply/replyQueue.ts'
import { AGENT_MESSAGES_FILE, AGENT_TOKEN_FILE, AGENT_TOKEN_HEADER, AgentMessages, ensureAgentToken, tokenMatches } from './reply/agentMessages.ts'
import type { AgentMessage } from './reply/agentMessages.ts'
import { LOOP_TICK_MS, LOOPS_FILE, LoopStore } from './reply/loops.ts'
import { WAITS_FILE, WAIT_TICK_MS, WaitStore } from './reply/waits.ts'
import { isWaitPrompt, WAIT_FAILING_MAX, WAIT_MAX_MS, WAIT_MAX_PER_SESSION, WAIT_POLL_MS, WAIT_READY_MAX_MS, WAIT_WAKES_PER_DAY, waitConfirmed, waitFromRequest, waitLimitRefusal, waitLive, waitOutcome, waitPrompt, waitPromptLabel, waitResultText, waitWakeable, wakesExhausted } from '../shared/waits.ts'
import type { WaitState } from '../shared/waits.ts'
import { clampInterval, loopAfterRound, loopFromRequest, loopHalt, loopLive, LOOP_NOTE_MAX, loopPrompt, loopPromptLabel } from '../shared/loops.ts'
import type { LoopState } from '../shared/loops.ts'
import {
  AGENT_SEND_MAX,
  AGENT_TEXT_MAX_CHARS,
  AGENT_TURN_READ_BUDGET,
  AGENT_BACKLOG_ROUND_MS,
  AGENT_REQUEST_MAX,
  requestRefusal,
  agentEntry,
  agentOverlap,
  acrossEntry,
  acrossLabel,
  acrossNames,
  targetNames,
  agentReplyRows,
  isAcross,
  deliveredId,
  deliveryMatcher,
  followupHead,
  followupReplyRows,
  HANDED_KEEP_DAYS,
  splitHandedReplies,
  STEERED_NOTE,
  WAKE_NOTE,
  withHandedReplies,
  replierName,
  agentTargets,
  budgetRefusal,
  clipReply,
  deliveredFromTailnet,
  deliveredText,
  isDeliveryOf,
  replyOf,
  resolveTarget,
  targetRefusal,
  sendHow,
  SEND_TO_ARG,
  SEND_COMPACT_ARG,
  SEND_COMPACT_NOTE,
  sessionLabel,
  tokensLabel,
  usageRefusal,
} from '../shared/agentMessages.ts'
import type { PendingReply } from '../shared/agentMessages.ts'
import { eventKind } from '../shared/events.ts'
import { stepLabel } from '../shared/progress.ts'
import { CONTEXT_WARN_TOKENS, contextRevKey } from '../shared/contextSize.ts'
import { treeOf, Worktrees } from './git/worktrees.ts'
import { mcpAccess, normalizeOrigin } from './mcp/access.ts'
import type { McpAccess } from './mcp/access.ts'
import { handleRpc, protocolVersionOk, textResult } from './mcp/protocol.ts'
import type { McpTool } from './mcp/protocol.ts'
import { MCP_SENDS_FILE, McpSendLimiter } from './mcp/sendLimit.ts'
import { SkillStore } from './local/skills.ts'
import type { Skill } from '../shared/skills.ts'
import { claudeProjectsDir, codexSessionsDir, tailLines, UsageStore } from './local/usage.ts'
import { QUEUE_ROLLOUT_TAIL_BYTES, queuedTextArrived, turnInProgress } from '../shared/codexQueue.ts'
import { ProgressReader, sessionOf } from './local/progress.ts'
import { agentListFromEnv, backgroundLive, type AgentList, type ClaudeAgent } from './local/claudeAgents.ts'
import { isRemoteHost } from '../shared/host.ts'
import { IMAGES_SEGMENT } from '../shared/images.ts'
import { imageHeaders, imageTable, readSessionImage, realImagePath } from './local/images.ts'
import { AnsweredApprovals, answeredAfter } from './approvals/answered.ts'
import { fileTable, readSessionFile } from './local/files.ts'
import { FILES_SEGMENT } from '../shared/files.ts'
import { TranscriptImages } from './local/transcriptImages.ts'
import { labelSuffixes } from '../shared/sessionLabels.ts'
import { CodexImages } from './local/codexImages.ts'
import { THUMB_MIN_BYTES, Thumbnails } from './local/thumbnails.ts'
import type { ThumbMaker } from './local/thumbnails.ts'
import { galleryFromRows, mergeGallery, rowTsAtOrAfter } from '../shared/gallery.ts'
import { searchRows } from './rows/search.ts'
import { searchWords } from '../shared/search.ts'
import { olderPrompts, parseRecent, recentRows } from '../shared/recentRows.ts'
import { codexTurnErrorReason, queuedTurnError } from '../shared/codexTurnError.ts'
import { alive, isDescendant, parsePs, RealTmux, realPs, TerminalBusy, TerminalGone, TerminalReplies, typeInto } from './reply/terminal.ts'
import type { DeliveryAnswer, DeliveryQuery, PsFn, Tmux } from './reply/terminal.ts'
import type { Runner } from './reply/runner.ts'
import { Authenticator, isLoopbackHostHeader, tailscaleWhois } from './auth.ts'
import type { Identity } from './auth.ts'
import type { FeedStore } from './rows/store.ts'

export const MAX_DAYS = 366
/** 返信 body の上限。指示文なので十分 */
export const MAX_REPLY_BYTES = 64 * 1024

/** 表示名の body の上限。名前だけなので十分 */
export const MAX_META_BYTES = 4 * 1024

const SESSIONS_PREFIX = '/api/sessions/'
/** 新しいセッションを始める（#314）。エンティティID は必ず `@` を含むので、`/api/sessions/<id>` と取り違えない */
const NEW_SESSION_PATH = '/api/sessions/new'
/** 新しいセッションを始められる場所（#319） */
const WORKSPACES_PATH = '/api/workspaces'
const APPROVALS_PATH = '/api/approvals'
const APPROVALS_PREFIX = '/api/approvals/'
const ANSWER_SUFFIX = '/answer'
/** 承認 body の上限。ツールの入力そのもの（Edit の new_string など）が入るので返信より大きめ */
export const MAX_APPROVAL_BYTES = 1024 * 1024
const SETTINGS_PATH = '/api/settings'
/** Claude のログインを聞き直す（#685。読むだけだが `claude` を起こすので POST・同一オリジンのみ） */
const CLAUDE_AUTH_CHECK_PATH = '/api/claude-auth/check'
/**
 * SAI から Claude にログインし直す（#577）。GET はいまの状態、POST は `start` / `code` / `cancel`。**どちらも同一オリジンのみ**
 * （応答にログイン用の URL が載る）。切れていると分かっているときしか起こさない（`ClaudeLogin.start()` が聞き直して決める）
 */
const CLAUDE_LOGIN_PATH = '/api/claude-auth/login'
/** ログインの body の上限（コードは 100 字前後） */
const MAX_LOGIN_BYTES = 8 * 1024
/** 一言が変だと言われたのを残す口（#346）。同一オリジンのみ */
const DIGEST_FEEDBACK_PATH = '/api/digest/feedback'
const USAGE_PATH = '/api/usage'
/** 使用量の画面の集計（#602）。SAI が起こしたターンの使用量（turn-usage.jsonl）を期間で切って足す。読むだけ */
const USAGE_REPORT_PATH = '/api/usage/report'
const SEARCH_PATH = '/api/search'
// GitHub に出ている PR（#524）。読むだけ
const PRS_PATH = '/api/prs'
/** 並べるリポジトリを拾うセッションの窓。アーカイブ済みのセッションのリポジトリも入る */
const PRS_REPO_DAYS = 30
/** `/api/prs/<owner>/<repo>/<番号>/review`（#526）。GitHub にレビューを投稿する */
const PR_REVIEW_SUFFIX = '/review'
/** 設定 body の上限 */
export const MAX_SETTINGS_BYTES = 4 * 1024
/** レビューの投稿（#526）の body の上限。文字数の上限（shared/prReview.ts）は parseReviewRequest() が見る */
export const MAX_PR_REVIEW_BYTES = 8 * 1024 * 1024
const REPLY_SUFFIX = '/reply'
const REVIEW_SUFFIX = '/review'
/** `POST /api/sessions/<id>/fork`（#405） */
const FORK_SUFFIX = '/fork'
/** 分岐先の表示名に足す印（元に表示名があるときだけ） */
const FORK_NAME_SUFFIX = '（分岐）'
const META_SUFFIX = '/meta'
/** 未読の印を置く（#502）。`PUT /api/sessions/<id>/read`。同一オリジンのみ */
const READ_SUFFIX = '/read'
/** Manager が置いた案を捨てる・入れた（#565）。`POST /api/sessions/<id>/suggestion`。同一オリジンのみ */
const SUGGESTION_SUFFIX = '/suggestion'
const ICON_SUFFIX = '/icon'
const SKILLS_SUFFIX = '/skills'
const MODELS_SUFFIX = '/models'
const PERMISSIONS_SUFFIX = '/permissions'
const DIFF_SUFFIX = '/diff'
const PROGRESS_SUFFIX = '/progress'
const GALLERY_SUFFIX = '/gallery'
/** 一言のもとになったターン完了の行（#537） */
const TURN_SUFFIX = '/turn'
/** `GET /api/sessions/<id>/turn-steps?ts=`（#605）。終わったターンで呼んだツール */
const TURN_STEPS_SUFFIX = '/turn-steps'
/** `GET /api/sessions/<id>/transcript-images/<key>`（#504）。id は `/` を含まないので、最初のこれが区切り */
const TRANSCRIPT_IMAGES_SEGMENT = '/transcript-images/'
/** `GET /api/sessions/<id>/codex-images/<key>`（#575）。Codex の画像生成で作った画像。鍵は一覧で見つけたファイル名だけ */
const CODEX_IMAGES_SEGMENT = '/codex-images/'
/** 同じ名前のセッションの本当の始まりを引く窓（#572）。重なりがあるときだけ使う */
const LABEL_START_DAYS = 90
/**
 * Codex のターンが閉じてから notify の行が書かれるまでの遅れ（#576 のレビュー）。行の `ts` は秒までで、record.py は
 * notify で起きてから rollout を読むので、実データでは同じ秒だった。余裕を見て数秒
 */
const CODEX_ROW_SLACK_MS = 5_000
const ATTACHMENTS_SUFFIX = '/attachments'
/** 預かった返信（#305）。`DELETE /api/sessions/<id>/queue/<queue_id>` と `POST /api/sessions/<id>/queue/resume` */
const QUEUE_SEGMENT = '/queue/'
const QUEUE_RESUME = 'resume'
/** 預かった返信を起動するときに見る窓（POST の reply の既定と同じ） */
const QUEUE_DAYS = 90
/** `claude --bg` のターンを待っている預かりを、次に見に行くまで（#462。画面のポーリングは 3 秒で、画面が複数あれば何倍にもなる） */
const BG_RETRY_MS = 10_000
/** エージェント用の口（#310）。SAI の MCP サーバ（approve-mcp.ts）の sai_* のツールだけが叩く。トークンを要り、ブラウザからは通さない */
const AGENT_PREFIX = '/api/agent/'
/** tailnet から MCP で呼ぶ口（#312。Streamable HTTP） */
const MCP_PATH = '/mcp'
const AGENT_SESSIONS_PATH = '/api/agent/sessions'
/** `overlap`（#564）の材料を覚える時間 */
export const CHANGED_PATHS_TTL_MS = 30_000
const AGENT_SEND_PATH = '/api/agent/send'
/** `sai_sessions` の行に PR を足すとき、まだ 1 回も引いていないリポジトリを待つ長さ（#727。前の結果があれば待たない） */
const HOLDING_PR_WAIT_MS = 1500
/** 前に引いた PR の一覧を「いま」として出してよい古さ（#727）。これより古ければ、まだ引いていないのと同じに扱う（短く待つ） */
const HOLDING_PR_STALE_MS = 10 * 60_000
/** 「頼まれて未完」を数える依頼の新しさ（日。#727）。返答の来なかった古い依頼を、いつまでも頼まれ中に数えない */
const HOLDING_ASK_DAYS = 2
/** 立て直したあと、前のサーバが残した預かり（#727）を送り始めるまでの間（引き取った子プロセスの様子が分かってから） */
const BACKLOG_STARTUP_MS = 5_000
const AGENT_WAIT_PATH = '/api/agent/wait'
/** `sai_loop_next`（#634）。エージェントが周の終わりに「次」を言う口 */
const AGENT_LOOP_PATH = '/api/agent/loop'
/** 人がループを組む・片付ける（`/loop`）と、止める・再開・いま起こす（#634）。長い方から突き合わせる */
const LOOP_SUFFIXES = ['/loop/stop', '/loop/resume', '/loop/wake', '/loop'] as const
/** `sai_wait_for`（#732）。エージェントが「PR の CI が終わったら起こして」を預ける口 */
const AGENT_WAIT_FOR_PATH = '/api/agent/wait-for'
/** 人が待ちを止める・いま起こす（#732）。どの待ちかは body の `wait` */
const WAIT_SUFFIXES = ['/wait/stop', '/wait/wake'] as const
/** sai_wait をサーバ側で待つ間、相手の返答の行が届いたかを見る間隔 */
const AGENT_POLL_MS = 1000
/** 処理中のターンを止める口（#384）。`POST /api/sessions/<id>/interrupt`。同一オリジンのみ */
const INTERRUPT_SUFFIX = '/interrupt'
/** 止めたあと、預かりを自動で回さないでおく理由（画面の `QueuedBubble` に出て、「続けて送る」で人が回す） */
const INTERRUPT_PAUSE = '前のターンを止めたので、預かった返信は止めています。続けるなら「続けて送る」'
/** 人が画面から送信を止める・再開する口（#311）。`POST /api/sessions/<id>/agent/stop`・`.../agent/resume`。同一オリジンのみ */
const AGENT_STOP_SUFFIX = '/agent/stop'
const AGENT_RESUME_SUFFIX = '/agent/resume'
/** 配る側。GET /api/attachments/<dir>/<name> */
const ATTACHMENTS_PREFIX = `/api/${ATTACHMENTS_DIR}/`
const PROFILE_PATH = '/api/profile'
const PROFILE_ICON_PATH = '/api/profile/icon'
/** 今まで使ったアイコン画像（#465）。一覧は GET、1 枚は `/<key>` の GET / DELETE */
const ICON_HISTORY_PATH = '/api/icon-history'

/**
 * `/api/sessions/<id>[<suffix>]` から id を取り出す。空、`/` を含む、%-エンコードが壊れている
 * （decodeURIComponent の URIError）は null で、呼び出し側は 400 bad session id にする。
 * 詳細 / reply / meta / icon の 4 経路が同じ判定を使い、「id がおかしい」の扱いを揃える。
 * suffix 無し（詳細）のときだけ末尾の `/` を許す（`/api/sessions/<id>/`）
 */
export function sessionIdFrom(path: string, suffix = ''): string | null {
  let raw = path.slice(SESSIONS_PREFIX.length, path.length - suffix.length)
  if (!suffix) raw = raw.replace(/\/+$/, '')
  let id: string
  try {
    id = decodeURIComponent(raw)
  } catch {
    return null // URIError: URI malformed。クライアントの入力ミスなので 500 にしない
  }
  return !id || id.includes('/') ? null : id
}

/**
 * 別オリジンからの POST か。ブラウザからコマンドが走るので、ローカルで開いている別サイトからの
 * CSRF でエージェントを走らせない。ブラウザは POST に Origin か Sec-Fetch-Site を必ず付ける。
 * どちらも無いのは curl などブラウザ以外なので通す（そもそもコマンドを直接叩ける相手）。
 */
export function isCrossOrigin(req: IncomingMessage): boolean {
  const site = req.headers['sec-fetch-site']
  if (typeof site === 'string' && site !== 'same-origin' && site !== 'none') return true
  const origin = req.headers.origin
  // tailscale serve 経由だとブラウザは https で Serve に繋ぎ、Origin は https://<MagicDNS 名> になる。
  // Serve が付ける X-Forwarded-Proto でスキームを合わせる（ブラウザは X-Forwarded-* を自分では付けられない）
  const proto = req.headers['x-forwarded-proto'] === 'https' ? 'https' : 'http'
  if (typeof origin === 'string' && origin !== `${proto}://${req.headers.host ?? ''}`) return true
  return false
}

/** API に載せる形。ローカルの直アクセスは null */
export function viewerOf(who: Identity): Viewer | null {
  return who.kind === 'tailnet' ? (who.name ? { login: who.login, name: who.name } : { login: who.login }) : null
}

async function readBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buf = chunk as Buffer
    size += buf.length
    if (size > limit) throw new Error('body too large')
    chunks.push(buf)
  }
  return Buffer.concat(chunks)
}

async function readJson(req: IncomingMessage, limit: number): Promise<unknown> {
  return JSON.parse((await readBody(req, limit)).toString('utf-8') || 'null')
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.woff2': 'font/woff2',
}

const NO_DIST =
  '<!doctype html><meta charset=utf-8><title>SAI</title>' +
  "<body style='font-family:sans-serif;padding:2em'>" +
  '<h1>SAI</h1><p><code>web/dist/</code> がありません。先にビルドしてください:</p>' +
  '<pre>pnpm install &amp;&amp; pnpm build</pre>' +
  '<p>開発中は <code>pnpm dev</code> で Vite を立てると、このサーバの API に流れます。</p>'

export function parseDays(raw: string | null, fallback: number): number {
  const n = Number.parseInt(raw ?? '', 10)
  if (Number.isNaN(n)) return fallback
  return Math.max(1, Math.min(MAX_DAYS, n))
}

/**
 * 処理中の返信を rev に混ぜる。画面は rev が同じなら state を触らないので、JSONL が変わらないまま
 * 「処理中 → 終了」になっても再描画されない。since まで含めるので、同じ id の連続した返信も区別できる
 */
/**
 * 端末で開いているセッションの集合の鍵（#495）。走査は要求の締切のあとも裏で続くので、次の要求で `terminal` が
 * 付いた・消えたら rev が変わるようにする（画面は rev が同じなら描き直さない）。1 つも無ければ空
 */
export function terminalKey(sessions: readonly Pick<SessionSummary, 'id' | 'terminal'>[]): string {
  const parts = sessions.filter((s) => s.terminal).map((s) => `${s.id}:${s.terminal!.pane}:${s.terminal!.pid}`).sort()
  if (parts.length === 0) return ''
  return createHash('sha1').update(parts.join('\n')).digest('hex').slice(0, 8)
}

export function revWith(rev: string, replying: ReplyingMap, approvalsKey = '', buildStale = false, digestKey = '', queueKey = ''): string {
  const ids = Object.keys(replying).sort()
  if (ids.length === 0 && !approvalsKey && !buildStale && !digestKey && !queueKey) return rev
  const h = createHash('sha1')
  // 失敗が付いたときも画面に伝えたい（since は変わらないので、そのままでは rev が動かない）
  // 失敗には終了コードが無いこともある（端末・queue で届かなかった。#329）ので、有無そのものも混ぜる
  for (const id of ids) {
    const failed = replying[id]!.failed
    // ログイン切れの印（#685）も混ぜる（付いた・外れたを詳細とフィードにも伝える）
    h.update(`${id}\n${replying[id]!.since}\n${failed ? `failed:${failed.code ?? ''}${failed.logged_out ? ':out' : ''}` : ''}\n`)
  }
  h.update(`approvals:${approvalsKey}`)
  // ビルドが古いかが変わったら画面に伝えたい（画面は rev が同じなら描き直さない）
  h.update(`stale:${buildStale ? 1 : 0}`)
  // 一言（digest）ができたら、JSONL が変わらなくても差し替えたい
  h.update(`digest:${digestKey}`)
  // 預けた・回した・取り消した・止めた、も画面に伝えたい（#305）
  h.update(`queue:${queueKey}`)
  return `${rev}:${h.digest('hex').slice(0, 8)}`
}

/** フィード用に行から thinking を落とす。無い行はそのまま返す（コピーしない） */
export function stripThinking(row: FeedRow): FeedRow {
  if (row.thinking === undefined) return row
  const rest = { ...row }
  delete rest.thinking
  return rest
}

/**
 * このリクエストを受けたサーバ自身の URL（`http://127.0.0.1:8787` など）。同じマシンの子プロセス（approve-mcp.ts）が
 * サーバに戻ってくるための宛先で、ブラウザの Host（tailscale serve のホスト名など）は使わない。
 * IPv6（::1）は角括弧で囲む。ソケットが無い（テストの偽物など）ときは localhost:8787
 */
export function selfUrl(req: Pick<IncomingMessage, 'socket'>): string {
  const address = req.socket?.localAddress ?? ''
  const port = req.socket?.localPort ?? 0
  if (!address || !port) return 'http://127.0.0.1:8787'
  const host = address.includes(':') ? `[${address.replace(/^::ffff:/, '')}]` : address
  // IPv4-mapped IPv6（::ffff:127.0.0.1）は IPv4 に戻す
  const v4 = address.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/)
  return `http://${v4 ? v4[1] : host}:${port}`
}

export type Handler = (req: IncomingMessage, res: ServerResponse) => Promise<void>

/** `createApp()` の戻り。リクエストを捌く関数に、終わるときの後始末（#457）が付いている */
export type App = Handler & {
  /** SAI が起こした長寿命の子（`opencode serve`）を落とす。`main.ts` の `shutdown()` が 1 度だけ呼ぶ */
  dispose(): void
}

/** 返信を 1 本起動するときの指定。`POST .../reply` と、預かった返信を回す drain の両方が作る（#305） */
interface LaunchOptions {
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
}

/** 起動の結果。HTTP には書かずに返すので、POST はそのまま応答にし、drain は預かりを止める理由にする */
interface Launched {
  status: number
  body: ReplyResponse | ReplyError
  /**
   * `claude --bg` のセッションがターンを回している・許可を待っているので送らなかった（#462）。
   * 預かりを回す `drain()` は**止めずに次の機会を待つ**（SAI の外で動いているので、終わりを知らせる口が無い）
   */
  retry?: boolean
}

/** 端末（tmux）への打ち込みに使うもの。テストでは差し替える */
export interface TerminalDeps {
  tmux: Tmux
  ps: PsFn
  replies?: TerminalReplies
  /** pid の生存確認。テストでは差し替える */
  alive?: (pid: number) => boolean
  /** Codex の thread writer lock。テストでは差し替える */
  codexWriterActive?: (session: string) => Promise<boolean>
  /** 開いている Codex への queue。テストでは差し替える */
  codexQueue?: CodexQueue
  /** その pid が `codex app-server`（共有のデーモン）か（#653）。テストでは差し替える */
  codexAppServer?: AppServerProbe
  /** 記録した pid が死んでいる Codex を lock から引き直す（#332）。テストでは差し替える */
  codexTerminals?: CodexTerminalSource
  /** tmux のペインで動いている Codex（行を見ずに見つける。#417）。テストでは差し替える */
  codexPanes?: CodexPaneSource
  /** 開いている Codex TUI の質問・許可ダイアログ監視。テストでは差し替える */
  codexDialogs?: CodexDialogSource
  /** SAIから開始するCodex turnのapp-server client。テストでは差し替える */
  codexApp?: CodexApp
  /** OpenCode への返信を送る `opencode serve` の client（#382）。テストでは差し替える */
  opencodeApp?: OpencodeApp
  /** 端末で答えたぶんの待ちを畳む（#255）。テストでは差し替える */
  waitingSettle?: WaitingSettleSource
  /** 端末のダイアログ・待ちの走査を覚える長さ（#592。既定 `DIALOG_SCAN_TTL_MS`）。画面の変化をすぐ見たいテストは 0 にする */
  scanTtlMs?: number
  /** `claude --bg` で始める・止める（#462）。テストでは差し替える */
  claudeBackground?: BackgroundSessions
  /** `claude --bg` のターンを待つ預かりを見に行く間隔（#462）。テストでは 0 にする */
  bgRetryMs?: number
  /**
   * 許可が問題なさそうかを予想する Jev の口（#491）。**省略は「送らない」**。環境の `JEV_API_KEY` から組むのは main.ts だけ
   * （`jevFromEnv()`）。既定で環境から組むと、鍵のあるマシンでテストを回したときに本物の Jev へ送ってしまう
   */
  jev?: JevJudge | null
  /**
   * Claude Code のフックの配線のずれ（#567）。**省略は「読まない」**（本物の `~/.claude/settings.json` を読むのは main.ts だけ。
   * 既定で読むと、テストの結果が回したマシンの設定で変わる）
   */
  claudeHooks?: ClaudeHooksReader
  /** Claude のログインが切れていないかを聞く口（#685）。既定は聞かない（本物の `claude` を叩くのは `main.ts` が渡したときだけ） */
  claudeAuth?: ClaudeAuthReader
  /** SAI からのログイン（#577）。既定は起こさない（`NoClaudeLogin`）。本物を渡すのは `main.ts` だけ */
  claudeLogin?: ClaudeLoginRunner
  /**
   * その cwd にもう効いている許可のルール（#705。[常に許可] で同じ部品を足さないために見る）。**省略は「読まない」**
   * （本物の `~/.claude/settings.json` を読むのは main.ts だけ。既定で読むと、テストの結果が回したマシンの設定で変わる）
   */
  allowedRules?: (cwd: string) => Promise<string[]>
  /** Codex の画像生成で作った画像の置き場（#575）。テストでは一時ディレクトリを指す */
  codexImages?: CodexImages
  /** 画像の軽い版を作る口（#589）。テストでは偽の縮める口を渡した Thumbnails か noThumbs */
  thumbs?: ThumbMaker
  /** ループ（#634）が見る時計。テストでは進める */
  loopNow?: () => number
  /** ループを見に行く間隔（既定 `LOOP_TICK_MS`）。テストは 0 にしてタイマーを立てず、ポーリングのついでだけで回す */
  loopTickMs?: number
}

export function createApp(
  store: FeedStore,
  distDir: string,
  runner?: Runner,
  approvals: Approvals = new Approvals(),
  freshness: BuildFreshness = new BuildFreshness(distDir),
  digester?: Digester,
  auth: Authenticator = new Authenticator(tailscaleWhois()),
  terminal: TerminalDeps = { tmux: new RealTmux(), ps: realPs },
  skillStore: SkillStore = new SkillStore(),
  git: Git = new RealGit(),
  pr: PrLookup = prLookupFromEnv(),
  // 使用率のファイル（usage-claude.json）は feed dir に置かれるので、--feed-dir をそのまま渡す
  usageStore: UsageStore = new UsageStore(codexSessionsDir(), claudeProjectsDir(), store.directory),
  // 処理中のターンの手順（#302）。読む先は使用量と同じ ~/.claude/projects と CODEX_HOME/sessions
  progress: ProgressReader = new ProgressReader(claudeProjectsDir(), codexSessionsDir()),
  // 生きている Claude のセッション（#418）。`claude agents --json` を叩くだけで、聞けなければ何も変えない
  // （名前は `agents`（#310 のセッション同士のメッセージ）と紛れるので `claudeAgents`）
  claudeAgents: AgentList = agentListFromEnv(),
  // GitHub の PR を読む口（#524）。`gh` を叩くのは読むサブコマンドだけ。`SAI_GH=0` なら読まない
  prs: PrBrowser = prBrowserFromEnv(),
): App {
  const distRoot = resolve(distDir)
  // 新しいセッションを始められる場所（#319）。`git worktree list` を読むだけ
  const worktrees = new Worktrees(git)
  // Claude の transcript の画像（#504）。transcript ごとに読んだところを覚えて、増えた分だけ読み足す
  const transcriptImages = new TranscriptImages()
  // Codex の画像生成で作った画像（#575）。rollout の item_completed から拾い、CODEX_HOME/generated_images/<スレッド>/ の中だけ配る
  const codexImages = terminal.codexImages ?? new CodexImages()
  // 画像の軽い版（#589）。置き場は feed dir の thumbs/（派生なので消してよい）。縮めるのは PATH の sips
  const thumbs = terminal.thumbs ?? new Thumbnails(join(store.directory, 'thumbs'))
  // 端末に打ち込んだ返信の「処理中」。子プロセスの方（run）とは別に持ち、画面には合わせて出す
  const typed = terminal.replies ?? new TerminalReplies()
  const isAlive = terminal.alive ?? alive
  // project の無いセッションを cwd から埋める（cwd をキーにキャッシュ）
  const projects = new ProjectResolver(git)
  const isCodexWriterActive = terminal.codexWriterActive ?? codexWriterActive
  const queueCodex = terminal.codexQueue ?? runCodexQueue
  const background = terminal.claudeBackground ?? new ClaudeBackground()
  const codexDialogs = terminal.codexDialogs ?? new CodexDialogs(terminal.tmux, terminal.ps, undefined, undefined, terminal.scanTtlMs ?? DIALOG_SCAN_TTL_MS)
  const codexApp = terminal.codexApp ?? new CodexAppServer()
  // 立て直しをまたいで同じ `opencode serve` を使う（#440）。ターンを回している間の C-c では落とさず、次の SAI が引き取る
  const opencodeApp = terminal.opencodeApp ?? new OpencodeServer(fetch, Date.now, undefined, { statePath: join(store.directory, OPENCODE_SERVE_FILE), logPath: join(store.directory, OPENCODE_SERVE_LOG) })
  // OpenCode の相手の大きさ（#396）。transcript が無いので本体に聞く（立っているサーバにだけ。#311 の予算がそのまま効く）。
  // テストが `read()` だけの偽物を渡すことがあるので、口が無ければ繋がない（その偽物は OpenCode を読まない）
  if (typeof progress.useOpencode === 'function') progress.useOpencode((session) => opencodeApp.context(session))
  // OpenCode の許可待ち（#421）。立っているサーバにだけ聞くので、返信を回していなければ何もしない
  const opencodePerms = new OpencodePermissions(opencodeApp)
  // 許可の確率（#491）。鍵が無ければ judge が null で、何も送らない
  const jevRisk = new JevRisk(terminal.jev ?? null)
  // フックの配線のずれ（#567）。読むのは ttl に 1 回、設定の mtime が変わったときだけ
  const claudeHooks = terminal.claudeHooks ?? new NoClaudeHooks()
  const claudeAuth = terminal.claudeAuth ?? new NoClaudeAuth()
  const claudeLogin = terminal.claudeLogin ?? new NoClaudeLogin()
  const allowedRules = terminal.allowedRules ?? (async () => [] as string[])
  // ログインを聞き直した失敗（`<id>\n<since>` → その問い合わせ）。同じ失敗で何度も `claude` を起こさない。
  // 問い合わせそのものを持つのは、同時に来た応答（一覧と詳細）の後の方も答えを待つため（待たないと、印の無い失敗を先に返す）
  const authAsked = new Map<string, Promise<unknown>>()
  // 返信・新しいセッションで起こしたコマンド（エンティティ ID → `claude` / `codex` / `opencode`）。立て直すと忘れる（そのときはセッションの行で決める）
  const startedBin = new Map<string, string>()
  /**
   * Claude の返信が失敗していたら、ログインが切れていないかを 1 回だけ聞く（#685）。切れていると分かったら、その失敗に印を付ける
   * （画面は「ログインが切れています」と出す）。実際に切れたときの `claude -p` の文言は分からないので、文言には頼らない。
   * 見るのはプロセスが非 0 で終わった失敗だけ（届かなかった・ターンのエラーは別の理由）。Claude かどうかは、起こしたコマンド
   * （`startedBin`。行の無い新しいセッションもこれで分かる）、無ければセッションの行で決める。**どちらでも分からなければ聞かない**
   * （Codex・OpenCode の失敗に「Claude のログインが切れています」と出さない）
   */
  const withAuth = async (replying: ReplyingMap, sessions: readonly SessionSummary[]): Promise<ReplyingMap> => {
    const failed = Object.entries(replying).filter(([id, r]) => {
      if (!r.failed || r.failed.code === undefined || r.failed.turn_error) return false
      const bin = startedBin.get(id)
      return bin !== undefined ? bin === 'claude' : sessions.find((s) => s.id === id)?.agent === 'claude'
    })
    const keys = new Set(failed.map(([id, r]) => `${id}\n${r.since}`))
    for (const key of authAsked.keys()) if (!keys.has(key)) authAsked.delete(key)
    if (failed.length === 0) return replying
    for (const key of keys) if (!authAsked.has(key)) authAsked.set(key, claudeAuth.check())
    await Promise.all([...keys].map((key) => authAsked.get(key)))
    if (claudeAuth.peek()?.loggedIn !== false) return replying
    const out: ReplyingMap = { ...replying }
    for (const [id, r] of failed) out[id] = { ...r, failed: { ...r.failed!, logged_out: true } }
    return out
  }
  const waitingSettle = terminal.waitingSettle ?? new WaitingSettle(terminal.tmux, terminal.ps, terminal.scanTtlMs ?? DIALOG_SCAN_TTL_MS)
  const codexAppEnabled = process.env.SAI_CODEX_APP_SERVER !== '0'
  // OpenCode は `opencode serve` の HTTP に送る（#382）。`0` で今までどおり `opencode run -s` に戻す
  const opencodeServerEnabled = process.env.SAI_OPENCODE_SERVER !== '0'
  const terminalEnabled = process.env.SAI_TERMINAL !== '0'
  /** 一番新しい行に pane と pid があり、pid が生きていれば端末で開いている */
  /**
   * `/` の候補になるスキル（#402）。Claude は今までどおり置き場から。
   * Codex は**リポジトリ側を cwd から読み**（`.codex/skills/` と `.agents/skills/`）、
   * cwd に依らない分（`$CODEX_HOME/skills/`・プラグイン・組み込み）を app-server の `skills/list` から足す。
   * 同じ名前ならリポジトリ側が勝つ。OpenCode と Grok にはスキルの仕組みが無いので空
   */
  const sessionSkills = async (s: SessionSummary): Promise<Skill[]> => {
    if (s.agent === 'claude') return await skillStore.forCwd(s.cwd)
    // OpenCode は手元を読まずに**本体に聞く**（#393。`/command` がスキルもスラッシュコマンドも 1 本で返す）。
    // サーバを切っていれば（SAI_OPENCODE_SERVER=0）聞きに行かない（`/` の候補のためだけにサーバを起こさない）
    if (s.agent === 'opencode') return opencodeServerEnabled ? await opencodeApp.skills(s.cwd).catch(() => []) : []
    if (s.agent !== 'codex') return []
    const repo = await skillStore.forCwd(s.cwd, 'codex')
    if (!codexAppEnabled) return repo
    const seen = new Set(repo.map((skill) => skill.name))
    return [...repo, ...(await codexApp.skills?.() ?? []).filter((skill) => !seen.has(skill.name))]
  }

  const isCodexAppServer = terminal.codexAppServer ?? codexAppServer
  const codexTerminals =
    terminal.codexTerminals ??
    new CodexTerminals({
      alive: isAlive,
      // lock を握っているのが tmux の外のプロセスのことがある（実測: ChatGPT アプリの codex app-server）ので、
      // そのペインの子孫かまで確かめる。打ち込む前の検査（inspectPrompt）と同じ見方
      inPane: async (pane, pid) => {
        try {
          const panePid = Number((await terminal.tmux.run(['display-message', '-p', '-t', pane, '#{pane_pid}'])).trim())
          if (!panePid || !isDescendant(pid, panePid, parsePs(await terminal.ps()))) return false
          // ペインの中でも、共有のデーモン（`codex app-server`）は端末ではない（#653。Codex 0.160 のデーモンは
          // 起こした TUI のペインの子孫で、回している**どのスレッドの行も lock も**そのペインを指す）
          return !(await isCodexAppServer(pid))
        } catch {
          return false
        }
      },
    })
  /**
   * 端末（tmux のペイン）で開いているか。記録した pid が生きていればそれ。
   *
   * **Codex だけ補欠がある**（#332 の案 2）: pid が死んでいても、そのセッションの thread writer lock を
   * 握っている生きたプロセスがいればそれを本体とみなす。`record.py` が Codex の pid を親から辿るようになる
   * 前（#335 以前）の行は notify のラッパー（すぐ終わるシェル）の pid を持っていて、ペインでは Codex が
   * 動いているのに「端末で開いていない」ままだった（許可待ちの検出にも端末への打ち込みにも回らない）。
   * lock はセッション ID ごとのファイルなので、同じペインで別の Codex を起動し直していても取り違えない。
   *
   * **`soft` は画面に出す一覧だけ**（#495）: 締切（`SCAN_WAIT_MS`）までに走査が終わらなければ前回の結果で返す。
   * **返信の振り分けとレビューの断りは待ち切る**（#496 のレビュー）。前回の結果が空（再起動の直後・ペインを開いた直後）の
   * ときに締切で抜けると「端末で開いていない」と読み、開いている TUI の会話をレビューの `thread/resume` が奪う・
   * 返信が端末に打ち込まれず別プロセスや queue に回る（0.154.0 の TUI は lock を開かないので `codexHeldElsewhere()` も拾えない）
   */
  const codexPanes = terminal.codexPanes ?? new CodexPanes({ tmux: terminal.tmux, appServer: isCodexAppServer })
  const terminalOf = async (s: SessionSummary, { soft = false }: { soft?: boolean } = {}) => {
    // 一覧は前回の結果があれば待たない（#592）。返信・レビューは待ち切る
    const wait = <T,>(work: Promise<T>, last: () => T, known: boolean): Promise<T> => (soft ? screenWait(work, last, known) : work)
    if (!terminalEnabled) return null
    if (s.pane && s.pid && isAlive(s.pid)) {
      if (s.agent !== 'codex' || !codexTerminals.owner) return { pane: s.pane, pid: s.pid }
      // **Codex の行の pid はペインの外のことがある**（#562。0.153 の TUI は共有の `codex app-server --listen` の客で、
      // notify を鳴らすのは app-server。行の pane は app-server を起こしたペインなので、その app-server が回す**どのスレッドの行も**
      // 同じペインを指す）。生きているだけで端末とみなすと、別の会話の TUI を端末と取り違える。ペインの中のときだけ採り、
      // 外なら下の補欠に落とす。一覧は締切までに引けなければ前回の結果（初回は今までどおり）
      const owner = await wait(codexTerminals.owner(s.pane, s.pid), () => codexTerminals.lastOwner?.(s.pane!, s.pid!) ?? s.pid!, codexTerminals.lastOwner?.(s.pane, s.pid) !== undefined)
      if (owner) return { pane: s.pane, pid: owner }
    }
    if (s.agent !== 'codex') return null
    const session = sessionOf(s)
    if (!session) return null
    if (s.pane) {
      // 一覧なら、締切までに引けなければ前回の結果（#495。lsof が重いときに一覧を止めない）
      const pid = await wait(codexTerminals.pid(session, s.pane), () => codexTerminals.last?.(session, s.pane!) ?? 0, codexTerminals.known?.(session, s.pane) ?? false)
      if (pid) return { pane: s.pane, pid }
    }
    // lock で引けない Codex（実測: 0.154.0 の TUI は lock を開かず、共有の app-server が握っている）は、
    // ペインで動いている codex が**いま開いている rollout**と突き合わせる（#417 / #429）。閉じていれば
    // プロセス開始秒・cwd と一致する一意の rollout にだけ落とす（#448）。**行の pane ではなく
    // いまのペイン**を使うので、ペインを移した・行がまだ 1 本も無いセッションでも当たる。
    // **cwd の新しい順では突き合わせない**（同じ worktree に会話が 2 本あると別の会話のペインに打ち込む。#429）
    const pane = (await wait(codexPanes.scan(), () => codexPanes.last?.() ?? [], codexPanes.known?.() ?? false)).find((p) => p.session === session)
    return pane ? { pane: pane.pane, pid: pane.pid } : null
  }
  /**
   * この Codex のスレッドを、**SAI の app-server 以外**（端末の TUI・VS Code 拡張や ChatGPT アプリの裏の
   * `codex app-server --listen`）が握っているか（#329 / #430）。lock は開いているプロセスがいるときだけ数え、
   * 補欠で記録時の pid も見る。**SAI の app-server が `thread/resume` 済みのもの（`codexApp.holds()`）は自分の持ち物なので false**
   * （app-server は resume したスレッドの lock をターンが終わっても開いたままにするので、見分けないと自分を「ほか」と数える）。
   *
   * **返信の振り分けとレビューの断りが同じ 1 つを見る**（#430）。別々に書いていたので、返信は queue に回すのに
   * レビューはそのまま `thread/resume` して、生きている TUI が握っている会話を奪っていた
   */
  const codexHeldElsewhere = async (session: SessionSummary, raw: string): Promise<boolean> => {
    if (session.agent !== 'codex') return false
    if (codexAppEnabled && (codexApp.holds?.(raw) ?? false)) return false
    if (await isCodexWriterActive(raw)) return true
    return session.pid > 0 && isAlive(session.pid) && !(await ownAppServer(session.pid))
  }
  /**
   * 行の `pid` が SAI 自身の app-server（かその子孫）か（#482）。SAI の app-server が回したターンでも `notify` は鳴り、
   * record.py は行の `pid` にその app-server を載せる（0.154.0 で実測）ので、`thread/closed` で `holds()` が偽になった
   * あとに自分を「ほか」と数えて、レビューを断り・返信を queue に回していた。`codex` が node の包みで起動されると
   * 行の `pid` は包みの子（本体）になるので、子孫まで見る
   */
  const ownAppServer = async (pid: number): Promise<boolean> => {
    const own = codexAppEnabled ? (codexApp.ownPid?.() ?? 0) : 0
    if (!own) return false
    if (pid === own) return true
    try {
      return isDescendant(pid, own, parsePs(await terminal.ps()))
    } catch {
      return false
    }
  }
  /**
   * 端末に打ち込んだ・queue に渡した返信のターンが、送った時刻より後に始まったか（#329。`TerminalReplies.checkDelivery()` が 2 分後に聞く）。
   * Claude は入力の行（UserPromptSubmit → `last_user_ts`）か transcript、Codex は rollout が送ったあとに書かれたかで見る。
   * **材料が無い（一覧に居ない・別のマシン・OpenCode・ファイルが見つからない）ときは届いた扱い**（届いていないと決めつけない）
   */
  const typedStarted = async (sessions: SessionSummary[], id: string, query: DeliveryQuery): Promise<DeliveryAnswer> => {
    const { since } = query
    const s = sessions.find((x) => x.id === id)
    // 材料が無いときは決めない（null）。届いた扱いにすると、その返信は TTL の上限が 6 時間に延びる（#559 のレビュー）。
    // 一覧の窓（days）に無い・別のマシン・Claude と Codex 以外は、30 分の TTL で今までどおり黙って消える
    if (!s || isRemoteHost(s.host, selfHost()) || (s.agent !== 'claude' && s.agent !== 'codex')) return null
    // queue に渡した Codex への返信は、**送った本文そのものが rollout に現れたか**で見る（#474）。mtime は「何か書かれた」で
    // しかなく、受け取り手のいない queue でも別の書き込みで進みうる。rollout が見つからなければ下の mtime の判定に落ちる
    if (s.agent === 'codex' && query.kind === 'queue') {
      const raw = sessionOf(s)
      const rollout = raw ? await progress.codexRollout?.(raw) : ''
      if (rollout) {
        const lines = await tailLines(rollout, QUEUE_ROLLOUT_TAIL_BYTES)
        if (queuedTextArrived(lines, query.text, Date.parse(since))) return true
        // 宛先がターンの途中なら、本文はそのターンが終わってから流れるかもしれない。決めずに次で聞き直す（#474 のレビュー）
        if (turnInProgress(lines, Date.now())) return null
        const holders = await codexLockHolders(raw)
        const shared = holders.find((h) => isAppServer(h.command))
        return shared ? `このスレッドはいま tmux の外の共有の Codex app-server（pid ${shared.pid}）が握っています。` : false
      }
    }
    // 行の ts は秒までなので、秒に丸めて比べる
    const at = Math.floor(Date.parse(since) / 1000) * 1000
    if (s.agent === 'claude' && s.last_user_ts && Date.parse(s.last_user_ts) >= at) return true
    const { updated_at } = await progress.read(s)
    if (!updated_at) return s.agent === 'claude' && s.last_user_ts ? false : null
    return Date.parse(updated_at) >= at
  }
  /**
   * 届いた Codex への返信（端末に打ち込んだ・queue に渡した）のターンが、エラーで終わっていればその理由（#475）。
   * エラーで終わったターンでは Codex が notify を鳴らさず行が残らないので、rollout の `task_complete.error` で見る。
   * 3 秒のポーリングのたびに末尾 4MB を読み直さないよう、rollout の (size, mtime) が変わったときだけ読む
   */
  const turnEndSeen = new Map<string, string>()
  const typedTurnError = async (sessions: SessionSummary[], id: string, query: DeliveryQuery): Promise<string | null> => {
    const s = sessions.find((x) => x.id === id)
    if (!s || s.agent !== 'codex' || isRemoteHost(s.host, selfHost())) return null
    const raw = sessionOf(s)
    const rollout = raw ? await progress.codexRollout?.(raw) : ''
    if (!rollout) return null
    const info = await stat(rollout).catch(() => null)
    const sig = info ? `${query.since}|${info.size}|${info.mtimeMs}` : ''
    if (!sig || turnEndSeen.get(id) === sig) return null
    turnEndSeen.set(id, sig)
    const message = queuedTurnError(await tailLines(rollout, QUEUE_ROLLOUT_TAIL_BYTES), query.text, Date.parse(query.since))
    return message ? codexTurnErrorReason(message) : null
  }
  /** 処理中の返信（子プロセス + 端末）。端末の分は、ターン完了の行が届いていれば先に片付け、届いたかを確かめる */
  /** そのセッションの一番新しいターン完了の行の `ts`。**OpenCode の分だけ**返す（#375 の settle の当て先） */
  const opencodeTurnOf = (sessions: SessionSummary[], id: string): string | undefined => {
    const session = sessions.find((s) => s.id === id)
    return session?.agent === 'opencode' ? session.last_turn : undefined
  }

  /** 返答を頭に足して起こしたターン（#594）。失敗したら「渡した」を取り消すために、終わるまで覚える（メモリだけ） */
  const handedTurns = new Map<string, { ids: string[]; at: number }>()
  /** 同じターンに何度か足す（頭に足したあと、途中でも足す）ので、覚えは足し合わせる。`at` は古い方（ターンの始まり側）を残す */
  const rememberHanded = (id: string, ids: readonly string[], at: number) => {
    const before = handedTurns.get(id)
    handedTurns.set(id, { ids: [...(before?.ids ?? []), ...ids], at: Math.min(before?.at ?? at, at) })
  }
  /** `sai_wait` が最後にそのメッセージを待っていた時刻（#594 の 2 で、待っている返答を入力の口からも足さないため） */
  const waitedAt = new Map<string, number>()
  /** 預かりに並んだ「起こす」（#594 の 3）。回ったら渡した扱いにし、取り消されたら渡していないままにする */
  const wakeQueued = new Map<string, { from: string; ids: string[]; queueId: string; origin: string }>()
  const replyingOf = async (sessions: SessionSummary[]): Promise<ReplyingMap> => {
    // 先に、行が届いて終わった返信を片付ける（TTL は見ない）。終わっている返信の配送を rollout を読んで確かめない（#559 のレビュー）
    const lastTurnOf = (id: string) => sessions.find((s) => s.id === id)?.last_turn
    typed.settle(lastTurnOf, { ttl: false })
    // 答えを返したのにプロセスが終わらない CLI（実測: `opencode run -s`）は、行が届いた時点で終わりにする（#375）。
    // 当てるのは OpenCode だけ（Claude の `-p` と SAI 管理の Codex は普通に終わるので、挙動を変えない）
    for (const id of run.settle?.((rid) => opencodeTurnOf(sessions, rid)) ?? []) await drain(id)
    for (const miss of await typed.checkDelivery((id, query) => typedStarted(sessions, id, query))) {
      // 画面の失敗は時間で消えるので、届かなかったことは reply.log にも残す（#474。あとから辿れるように）
      await appendFile(join(store.directory, 'reply.log'), `--- ${new Date().toISOString()} ${miss.id} ${miss.kind === 'queue' ? 'queue に渡した返信が届いていない' : '端末に打ち込んだ返信でターンが始まっていない'}: ${miss.reason}\n`).catch(() => {})
    }
    // 配送確認を TTL の整理より先にする（#559）。30 分以上ポーリングが空いても、届いていた長いターンの仮バブルを消さない
    typed.settle(lastTurnOf)
    // 届いたが、ターンがエラーで終わった（#475。行が残らないので、ここで拾わないと黙って消える）
    for (const miss of await typed.checkTurnEnd((id, query) => typedTurnError(sessions, id, query))) {
      await appendFile(join(store.directory, 'reply.log'), `--- ${new Date().toISOString()} ${miss.id} ${miss.kind === 'queue' ? 'queue に渡した' : '端末に打ち込んだ'}返信のターンがエラーで終わった: ${miss.reason}\n`).catch(() => {})
    }
    // OpenCode のサーバ経路も、行が届いた時点で終わりにする（子プロセスが無いので exit は来ない。#382）
    for (const id of opencodeApp.settle((rid) => opencodeTurnOf(sessions, rid))) await drain(id)
    // app-server のエラーで終わったターン（#475）は 30 分残るので、ほかの経路のいま回っている返信を上書きしないよう先に置く
    const app = Object.entries(codexApp.replying())
    const appFailed = Object.fromEntries(app.filter(([, r]) => r.failed))
    const appActive = Object.fromEntries(app.filter(([, r]) => !r.failed))
    const all: ReplyingMap = { ...appFailed, ...typed.snapshot(), ...run.snapshot(), ...appActive, ...opencodeApp.replying() }
    // 返答を頭に足したターン（#594）が失敗したら、「渡した」を取り消す（エージェントは読んでいない。次のターンでもう一度足す）。
    // 終わっていれば覚えを捨てる
    for (const [id, turn] of handedTurns) {
      const r = all[id]
      if (r?.failed && Date.parse(r.since) >= turn.at - 5000) {
        agents.unhand(turn.ids)
        handedTurns.delete(id)
      } else if (!r) handedTurns.delete(id)
    }
    // 画面に出す本文は人が打った文だけ（SAI が頭に足した返答の塊は外す。入力欄への戻し・一覧の 2 行目・↑ の履歴がこれを使う）
    for (const [id, r] of Object.entries(all)) {
      // ループの周の本文（#634）は長いので、「ループ N 周目」にする
      // 待ちで起こしたターン（#732）も同じく短い形にする
      const plain = waitPromptLabel(loopPromptLabel(splitHandedReplies(r.text).text))
      if (plain !== r.text) all[id] = { ...r, text: plain }
    }
    return all
  }
  // ターンごとのトークン・費用（#387 / #411）。書く側（ProcessRunner）と読む側（応答に載せる）で同じ 1 つを使う
  const usage = new TurnUsageLog(join(store.directory, TURN_USAGE_FILE))
  const usageReady = usage.load()
  // 処理中の返信は replying.json にも持ち、サーバを再起動しても生きている分を引き取る（#100）
  const run: Runner = runner ?? new ProcessRunner(join(store.directory, 'reply.log'), join(store.directory, 'replying.json'), usage, new ClaudeLimitsFile(join(store.directory, replyLimitsFile())))
  // 返信中の許可・質問の預かりも立て直しをまたぐ（#440）。引き取るのは、いま回っている返信の子（`replying.json` から引き取った分）のものだけ
  approvals.persistTo(join(store.directory, APPROVALS_FILE), (id) => run.running(id))
  // 許可に答えた記録（#445 / #582）。回数を数えて「常に許可」を勧めるのに使う（勧めるだけで、ルールは書かない）
  const approvalLog = new ApprovalLog(join(store.directory, APPROVAL_LOG_FILE))
  /**
   * [常に許可] を押すと書かれるルール（#705）。**組むのはここだけ**（画面の表示・回数の鍵・人の答え・Jev の自動が同じものを見る）。
   * つないだコマンドは部品ごとで、もう設定にあるルール（`ruleCovered()`）は足さない。Claude の `-p` の許可だけ
   * （Codex / OpenCode には「常に許可」が無い）。空なら [常に許可] を出さない。`cwd` はセッションの行から
   */
  const alwaysRules = async (a: Approval, cwd: string): Promise<PermissionRule[]> => (await alwaysPlan(a, cwd)).rules
  /**
   * `alwaysRules()` の中身。ルールが空のときは、なぜ空かの種類も返す（#724。記録の `no_rule` に書くだけで、判定には使わない）。
   * 「組めなかった」（Bash の形）と「組めたが全部もう設定にある」（`covered`）を分ける
   */
  const alwaysPlan = async (a: Approval, cwd: string): Promise<{ rules: PermissionRule[]; reason?: NoRuleReason }> => {
    // Claude の許可でない・画面から答えられない預かりは記録に足さない（`logAnswer()` に来ない）ので、理由も付けない
    if ((a.agent ?? 'claude') !== 'claude' || a.answerable === false) return { rules: [] }
    const plan = alwaysAllowPlan(a.tool_name, a.input, cwd)
    if (plan.rules.length === 0 || !cwd) return plan
    const allowed = await allowedRules(cwd).catch(() => [] as string[])
    const rules = plan.rules.filter((rule) => !ruleCovered(ruleLabel(rule), allowed))
    return rules.length > 0 ? { rules } : { rules, reason: 'covered' }
  }
  /**
   * 答えたことを記録に足す。cwd はセッションの行から（リクエストからは受けない）。コマンドの全文は書かない。`rule` は答える前に組んだ組。
   * `rule` が空なら、空だった理由の種類（`noRule`）を添える（#724）
   */
  const logAnswer = (a: Approval, cwd: string, rule: string, by: 'human' | 'jev', behavior: 'allow' | 'deny', remember: boolean, noRule?: NoRuleReason) => {
    try {
      const now = Date.now()
      const waited = Math.max(0, Math.round((now - Date.parse(a.since)) / 1000))
      approvalLog.record({ ts: new Date(now).toISOString(), id: a.id, cwd, tool: a.tool_name, rule, by, behavior, remember, waited_s: Number.isFinite(waited) ? waited : 0, ...(!rule && noRule ? { no_rule: noRule } : {}) })
    } catch {
      // 記録できなくても答えは止めない
    }
  }
  const metaStore = new MetaStore(join(store.directory, META_FILE))
  // 未読の印（#502）。立て直しても消えないようにファイルに持つ
  const readStore = new ReadStore(join(store.directory, READ_MARKS_FILE))
  // Manager が入力欄に置いた案（#565）。1 セッションに 1 つ
  const suggestionStore = new SuggestionStore(join(store.directory, SUGGESTIONS_FILE))
  const iconStore = new IconStore(join(store.directory, ICONS_DIR))
  const iconHistory = new IconHistory(join(store.directory, ICON_HISTORY_DIR), join(store.directory, ICON_HISTORY_FILE), iconStore)
  const attachmentStore = new AttachmentStore(join(store.directory, ATTACHMENTS_DIR))
  const profileStore = new ProfileStore(join(store.directory, PROFILE_FILE))
  // 処理中に送った返信の預かり（#305）。replying.json と同じくファイルにも持ち、再起動で消さない
  const queue = new ReplyQueueStore(join(store.directory, QUEUE_FILE))
  // 起動している最中のセッション。POST と drain が同じセッションを同時に起動しないように（spawn までの隙を塞ぐ）
  const launching = new Set<string>()
  // 預かりを回している最中のセッション（exit の知らせとポーリングが重なっても 1 本だけ）
  const draining = new Set<string>()
  // 失敗で止めたあと「続けて送る」を押したときの、その失敗（`Replying.since`）。同じ失敗でもう一度止めない
  const resumedFailure = new Map<string, string>()
  // セッション同士のメッセージ（#310 / #311）。トークンは feed dir のファイルに 0600 で置き、MCP サーバはその場所だけ受け取って読む
  const agentTokenPath = join(store.directory, AGENT_TOKEN_FILE)
  const agentToken = ensureAgentToken(agentTokenPath)
  // 送った記録・止めたセッション・1 ターンの回数と量は、立て直しても残す（#440）
  const agents = new AgentMessages(join(store.directory, AGENT_MESSAGES_FILE))
  // セッションに組んだループ（#634）。立て直しても続くようにファイルにも持つ
  const loops = new LoopStore(join(store.directory, LOOPS_FILE))
  // 預かっている待ち（#732）。時計と見に行く間隔はループと同じもの（`loopNow` / `loopTickMs`）を使う
  const waits = new WaitStore(join(store.directory, WAITS_FILE))
  const loopNow = terminal.loopNow ?? Date.now

  /**
   * 端末で人が答えたぶんの待ちを畳む（#255。#232 の積み残し）。行（集計）は触らず、応答を組み立てる
   * ときだけ空にするので、要対応・サイドバーの「待機中」・チャット見出しがまとめて正しくなる。
   * `SAI_TERMINAL=0` なら見に行かない（`CodexDialogs` と同じ）
   */
  const settleWaiting = async (sessions: SessionSummary[]): Promise<{ sessions: SessionSummary[]; key: string }> => {
    // OpenCode は tmux を見ないので `SAI_TERMINAL` とは別（#422。答える相手のプロセスが消えた待ちを畳む）。
    // **畳む前の一覧で保留を引く**（畳んだあとの `waiting` を見ると、そのセッションを聞きに行かなくなる）。
    // 引いた分は `PENDING_TTL_MS` の間キャッシュされるので、このあとの `approvalsNow()` は投げ直さない
    if (opencodeServerEnabled) await opencodePerms.scan(sessions)
    const opencode = opencodeServerEnabled ? opencodePerms.settle(sessions, selfHost()) : new Set<string>()
    // 締切までに見終わらなければ前回の結果（#495）
    const terminal = terminalEnabled ? await screenWait(waitingSettle.scan(sessions), () => waitingSettle.last?.() ?? new Set<string>(), waitingSettle.known?.() ?? false) : new Set<string>()
    if (opencode.size === 0 && terminal.size === 0) return { sessions, key: '' }
    const settled = new Set([...terminal, ...opencode])
    return { sessions: clearSettled(sessions, settled), key: settledKey(settled) }
  }

  /** cwd の git のトップの名前（`record.py` の `repo` と同じ決め方）。引けなければ空。cwd ごとに 1 回だけ叩く */
  const repoNames = new Map<string, string>()
  const repoOf = async (cwd: string): Promise<string> => {
    const hit = repoNames.get(cwd)
    if (hit !== undefined) return hit
    let name = ''
    try {
      name = basename((await git.run(cwd, ['rev-parse', '--show-toplevel'])).trim())
    } catch {
      name = ''
    }
    repoNames.set(cwd, name)
    return name
  }

  /**
   * **行がまだ 1 本も無い**、ペインで動いている Codex（#417）。`notify` はターン完了でしか鳴らないので、
   * 最初のターンの許可で止まったセッションは記録に 1 行も無く、SAI からは存在が見えなかった。
   * **足すのはダイアログの監視（= 要対応）にだけ**で、一覧と集計（行から作る）は触らない
   */
  const paneOnlyTargets = async (sessions: SessionSummary[]): Promise<DialogTarget[]> => {
    const known = new Set(sessions.map((s) => sessionOf(s)).filter(Boolean))
    const out: DialogTarget[] = []
    for (const pane of await screenWait(codexPanes.scan(), () => codexPanes.last?.() ?? [], codexPanes.known?.() ?? false)) {
      if (!pane.session || known.has(pane.session)) continue
      out.push({ id: entityId(pane.session, await repoOf(pane.cwd), ''), terminal: { pane: pane.pane, pid: pane.pid } })
    }
    return out
  }

  /** Claude、SAI管理のCodex、通常Codex TUIの検出専用ダイアログ、SAI が起こした OpenCode の許可（#421）を合わせる。 */
  // 画面から答えた許可（#693）。答えるとバブルが消えるだけで、Codex はターンが終わるまで何も出なかった。メモリだけ
  const answered = new AnsweredApprovals()
  /** 画面に出したことのある許可（approval_id → 中身）。答えたときに、どのセッションの何だったかを引く。画面に出していないものは答えられない */
  const shownApprovals = new Map<string, Approval>()
  const rememberShown = (map: ApprovalMap): ApprovalMap => {
    const live = new Set<string>()
    for (const list of Object.values(map)) {
      for (const a of list) {
        live.add(a.approval_id)
        shownApprovals.set(a.approval_id, a)
      }
    }
    // 消えたものは捨てる（答えた直後に引くので、答える口が先に引いてから次の走査が来る）
    if (shownApprovals.size > 500) for (const key of shownApprovals.keys()) if (!live.has(key)) shownApprovals.delete(key)
    return map
  }
  /** 答えが通ったあとに覚える。押した選択肢の文言は、画面に渡していた `decisions` から引く（画面の文字列は信じない） */
  const noteAnswered = (approvalId: string, behavior: 'allow' | 'deny', decision?: string) => {
    const shown = shownApprovals.get(approvalId)
    if (!shown) return
    answered.add(shown, behavior, shown.decisions?.find((d) => d.id === decision)?.label ?? '')
  }
  const approvalsNow = async (sessions: SessionSummary[]) => {
    const [dialogs, opencode] = await Promise.all([
      // 締切までに見終わらなければ前回の走査で見えていたダイアログ（#495）
      terminalEnabled ? screenWait(codexDialogs.scan(sessions, await paneOnlyTargets(sessions)), () => codexDialogs.snapshot?.() ?? {}, codexDialogs.known?.() ?? false) : Promise.resolve({} as ApprovalMap),
      opencodeServerEnabled ? opencodePerms.scan(sessions) : Promise.resolve({} as ApprovalMap),
    ])
    const all = mergeApprovalMaps(mergeApprovalMaps(mergeApprovalMaps(approvals.snapshot(), codexApp.snapshot()), dialogs), opencode)
    // [常に許可] で書かれるルール（#705）と、同じ cwd で同じ組の何回目か（#445）。数えるのは人が許可した回数で、
    // 決めた回数からは「常に許可」を勧める（勧めるだけ）
    const merged: ApprovalMap = {}
    for (const [id, list] of Object.entries(all)) {
      const cwd = sessions.find((s) => s.id === id)?.cwd ?? ''
      merged[id] = await Promise.all(list.map(async (a) => {
        const always = (await alwaysRules(a, cwd)).map(ruleLabel)
        if (always.length === 0) return a
        if (!cwd) return { ...a, always }
        const count = approvalLog.count(cwd, rulesKey(always)) + 1
        return { ...a, always, count, suggest: count >= APPROVAL_SUGGEST_AT }
      }))
    }
    // 問題なさそうかの確率（#491）。聞いていないものは投げるだけで、届いたら次の応答に載る（rev は approvalMapKey が拾う）
    // 読む経路（一覧・詳細・フィード・MCP の sai_sessions）は写しに確率を付けるだけで、預かりの本物は触らない。
    // 自動の「常に許可」（#499）は jevAutoTick が別に動く（読んだだけで許可が書かれない）
    const s = await settingsStore.get()
    const annotated = jevRisk.annotate(merged, s.jev)
    if (!s.jev || s.jev_auto <= 0) return rememberShown(annotated)
    // 自動の「常に許可」で書かれるルールの確率も添える（#553）。**聞くのは jevAutoOnce だけ**で、ここは覚えているものを見るだけ
    // （読む経路から外へ送らない）。この回が 90% でもルールは低く出ることが多く、出さないと答えない理由が見えなかった
    const out: ApprovalMap = {}
    for (const [id, list] of Object.entries(annotated)) {
      out[id] = list.map((a) => {
        if (!jevAutoEligible(a)) return a
        // 部品ごとのルールのうち一番低いもの（#705。全部が届いてから出す）
        const lowest = jevLowestRule((a.always ?? []).map((label) => ({ label, safe: jevRisk.peekRule(label) })))
        return lowest ? { ...a, jev_rule: lowest } : a
      })
    }
    return rememberShown(out)
  }

  /** 「常に許可」の答えに付けるもの（#96）。CLI が cwd の .claude/settings.local.json に書く（端末の「今後も許可」と同じ） */
  const permissionsFor = (rules: PermissionRule[]): PermissionUpdate[] => [{ type: 'addRules', rules, behavior: 'allow', destination: 'localSettings' }]

  /**
   * Jev の確率が閾値以上の許可を、人を待たずに [常に許可] と同じ答えで返す（#499）。
   * **読む経路からは呼ばない**（一覧のポーリングや MCP の `sai_sessions` が許可を書いてはいけない。タブが無くても動く）。
   * 動くのは 3 つの時: 許可を預かった時（POST /api/approvals）、Jev の答えが届いた時（`jevRisk.onArrive`）、設定を変えた時。
   * 対象は `jevAutoEligible()`（Claude の `-p` の **Bash** だけ。Jev が見たコマンドと許可するものが同じ）。
   * **この回のコマンドとルールの両方**が閾値以上のときだけ答える: ルール（`Bash(rm:*)` のような前方一致）は Jev が見た 1 回より
   * 広いので、`ruleSafe()` で別の文を立てて聞く（届くまでは待つ。届いたら `onArrive` でもう一度ここに来る）。
   * つないだコマンドは**部品ごとに聞き、一番低いもの**で判定する（#705。全部の部品が閾値以上のときだけ答える）。
   * 答えは画面の [常に許可] とまったく同じ（`permissionsFor()`）。`approvals.answer()` は 2 回目に false を返すので二重に答えない。
   * 同時に走らせない（届くたびに呼ばれるので、走っている間の分は終わってからもう 1 回）
   */
  let jevAutoRunning: Promise<void> | null = null
  /** 見送りの理由を reply.log に書いた許可（#553。1 つの許可に 1 行だけ）。許可の id は使い回されないので消さない分は小さい */
  const jevSkipLogged = new Set<string>()
  let jevAutoAgain = false
  const jevAutoTick = (): Promise<void> => {
    if (jevAutoRunning) {
      jevAutoAgain = true
      return jevAutoRunning
    }
    jevAutoRunning = jevAutoOnce()
      .catch(() => {})
      .finally(() => {
        jevAutoRunning = null
        if (jevAutoAgain) {
          jevAutoAgain = false
          void jevAutoTick()
        }
      })
    return jevAutoRunning
  }
  const jevAutoOnce = async (): Promise<void> => {
    const s = await settingsStore.get()
    if (!s.jev || s.jev_auto <= 0 || !jevRisk.ready) return
    // 預かっている Claude の許可だけ（Codex / OpenCode には「常に許可」が無い）。聞いていないものはここで投げる
    const lines: string[] = []
    const { sessions } = await store.sessions(90)
    for (const list of Object.values(jevRisk.annotate(approvals.snapshot(), true))) {
      for (const a of list) {
        const cwd = sessions.find((session) => session.id === a.id)?.cwd ?? ''
        const rules = jevAutoEligible(a) ? await alwaysRules(a, cwd) : []
        const labels = rules.map(ruleLabel)
        // ルールはこの回が閾値以上のときだけ聞く（聞くだけで外に出るので、自動を期待しない回には送らない）
        const asked = jevAutoAllows(a.jev, s.jev_auto) ? labels.map((label) => ({ label, safe: jevRisk.ruleSafe(label, jevRuleState(a, label)) })) : []
        const failed = asked.find((r) => r.safe === undefined && jevRisk.ruleFailed(r.label))?.label
        const lowest = jevLowestRule(asked)
        const decision = jevAutoDecision(a, s.jev_auto, labels.length > 0 ? (failed ?? lowest?.label ?? rulesKey(labels)) : null, failed ? 'failed' : lowest?.safe)
        if (decision.kind === 'skip') {
          // 答えない理由（#553）。同じ許可には 1 回だけ（届くたびに呼ばれるので、覚えないと同じ行が何本も並ぶ）
          if (!jevSkipLogged.has(a.approval_id)) {
            if (jevSkipLogged.size >= 1000) jevSkipLogged.clear()
            jevSkipLogged.add(a.approval_id)
            lines.push(`--- ${new Date().toISOString()} ${a.id} Jev の自動の常に許可を見送り（この回 ${jevPercent(a.jev!)}%）: ${decision.reason}\n`)
          }
          continue
        }
        if (decision.kind !== 'allow' || rules.length === 0 || !lowest) continue
        if (!approvals.answer(a.approval_id, { behavior: 'allow', updatedInput: a.input, updatedPermissions: permissionsFor(rules) })) continue
        logAnswer(a, cwd, rulesKey(labels), 'jev', 'allow', true)
        lines.push(`--- ${new Date().toISOString()} ${a.id} Jev が自動で常に許可（この回 ${jevPercent(a.jev!)}%、ルール ${jevPercent(lowest.safe)}%、閾値 ${jevPercent(s.jev_auto)}%）: ${rulesKey(labels)}\n`)
      }
    }
    if (lines.length > 0) void appendFile(join(store.directory, 'reply.log'), lines.join('')).catch(() => {})
  }
  jevRisk.onArrive = () => void jevAutoTick()

  /**
   * 質問（AskUserQuestion）で止まっているセッションの、選択肢まで入った質問（#333）。フックの待ちの行には質問の文しか無いので、
   * transcript の返事の付いていない tool_use から読む（`progress.read()` は (mtime, size) でキャッシュする）。
   * 載せるのは Claude で、このマシンのセッションで、**行の待ちがその質問と同じ文のとき**だけ（別の呼び出しの古い質問を出さない）。
   * SAI が回している `claude -p` の質問は答えられるバブル（approvals）が出るので、二重に出さない
   */
  const pendingQuestion = async (s: SessionSummary, pending: Record<string, readonly unknown[]>) => {
    if (s.agent !== 'claude' || !s.waiting.startsWith('質問') || isRemoteHost(s.host, selfHost())) return undefined
    if (run.running(s.id) || (pending[s.id]?.length ?? 0) > 0) return undefined
    const { question } = await progress.read(s)
    return question && question.text === s.waiting ? question : undefined
  }

  /**
   * 自分の表示名とアイコン。rev は profile.json とアイコンの状態で、名前や画像を変えたら応答の rev も変わる
   * （アイコンは session-icons/ に置くので iconStore の rev にも入るが、名前の分はここでしか変わらない）
   */
  const profileNow = async (): Promise<{ rev: string; profile: Profile }> => {
    const [{ rev, name }, icon] = await Promise.all([profileStore.get(), iconStore.get(PROFILE_ICON_ID)])
    const profile: Profile = {}
    if (name) profile.name = name
    if (icon) profile.icon = profileIconUrl(icon.version)
    return { rev: `${rev}|${icon?.version ?? ''}`, profile }
  }

  const settingsStore = new SettingsStore(join(store.directory, SETTINGS_FILE))
  // 一言コメント（digest）。テストは Summarizer を差し替えた Digester を渡す（その入切は渡した値のまま。settings.json では組み直さない）。
  // 既定は settings.json の入切・口・モデルで組む（#288。前は環境変数）。一言の性格は、セッションのメタに persona があればそれ、無ければ全体の既定
  const digest: Digester = digester ?? createDigester(store.directory, new DigestStore(join(store.directory, DIGEST_FILE)), { settings: settingsStore, meta: metaStore })
  const digestReady = (digester ? Promise.resolve() : settingsStore.get().then((s) => digest.configure(s))).then(() => digest.store.load())
  // 一言への「これは変」（#346）。溜めるだけで、読むのは人と手で走らせる物差しのスクリプト
  const feedback = new FeedbackStore(join(store.directory, FEEDBACK_FILE))

  /** 一言の対象を探して列に積む。3 秒ごとの応答のついでに呼ぶので軽い（無効なら何もしない） */
  const scanDigest = async (days: number): Promise<void> => {
    await digestReady
    // 一言か案のどちらかを作っていれば見る（#560）
    if (!digest.active) return
    digest.scan(await store.rows(days))
  }

  /**
   * 集計済みのセッションにメタ（表示名・アーカイブ）とアイコン画像の URL を載せる。store のキャッシュ配列は触らず新しい配列を返す。
   * rev にメタファイルとアイコンの状態も混ぜるので、名前を付けた・画像を差し替えた・アーカイブしただけでも画面のポーリングが拾う。
   * アーカイブ済みかは `archived_at >= end` で決める（集計 aggregate.ts は JSONL だけから作る、を守る）。
   * アーカイブ後に行が増えると end が archived_at を追い越すので、メタを書き換えずに自動で戻る
   */
  /**
   * 同じ名前のセッションの添え字（#572）。LABEL_START_DAYS の窓の集計（行が変わったときだけ組み直される）と表示名から決め、
   * 両方の rev が同じなら覚えたものを返す（3 秒のポーリングで組み直さない。実データの 90 日ぶんで 1 回 40ms ほど）
   */
  let labelMemo: { key: string; suffixes: Map<string, string> } | null = null
  const labelSuffixesNow = async (meta: { rev: string; entries: Record<string, SessionMeta> }): Promise<Map<string, string>> => {
    const wide = await store.sessions(LABEL_START_DAYS)
    const key = `${wide.rev}-${meta.rev}`
    if (labelMemo?.key === key) return labelMemo.suffixes
    const named = wide.sessions.map((s) => (meta.entries[s.id] ? { ...s, meta: meta.entries[s.id] } : s))
    const suffixes = labelSuffixes(named)
    labelMemo = { key, suffixes }
    return suffixes
  }

  // ターン完了の行が落ちた・本文が空だったターンの返答を transcript から補う（#614）。JSONL には書かず、応答の行に重ねるだけ
  const recovered = new RecoveredTurns(progress, { isRemote: (host) => isRemoteHost(host ?? '', selfHost()), busy: (id) => mcpBusy(id) })
  /**
   * 応答に載せる行。記録の行（`store.rows()`）に、補った行（`recovered: true`）を重ねたもの。
   * **人に見せる・返答を引く道はこちらを使う**（詳細・フィード・未読・セッション同士のメッセージの返答）。
   * 一言（digest）と集計（`store.sessions()`。`turns` はここで数える）は記録の行のまま
   */
  const rowsNow = async (days: number): Promise<FeedRow[]> => (await recovered.apply(await store.rows(days))).rows as FeedRow[]

  const sessionsWithMeta = async (days: number): Promise<{ rev: string; sessions: SessionSummary[] }> => {
    const [{ rev, sessions: raw }, meta, icons, reads, rows, drafts] = await Promise.all([store.sessions(days), metaStore.all(), iconStore.all(), readStore.get(), store.rows(days), suggestionStore.all()])
    // project / remote の無い古い行のセッションは cwd から git で引いて埋める（cwd ごとに 1 回だけ。#182、#212）
    const sessions = await fillRepo(projects, raw)
    // 補った返答（#614）を重ねた行。未読はこちらで数える（終わったことを知らせる）。`turns` は集計のまま進めない
    const shown = await recovered.apply(rows)
    // 未読の数（#502）。印は read-marks.json、数えるのは窓の中のターン完了の行
    const unread = unreadCounts(shown.rows, reads.marks)
    // Manager の案（#565）。出すのは 24 時間以内で、置いたあとに人の入力が来ていないものだけ。
    // rev には「いま出している案」を混ぜる（ファイルの (mtime, size) だと 24 時間が過ぎて消えたときに変わらない）
    // 人の入力が来たかは、置いた時刻より後のそのセッションの行で見る。24 時間は日付を 2 つまたぐので、窓が 1 日でも 2 日ぶん読む
    const nowMs = Date.now()
    const live = new Map<string, ManagerDraft>()
    const placed = new Set(sessions.map((s) => s.id).filter((id) => drafts[id]))
    if (placed.size > 0) {
      const rowsOf = new Map<string, FeedRow[]>()
      for (const r of days >= 2 ? rows : await store.rows(2)) {
        const id = entityId(r.session ?? '', r.repo ?? '', String(r.ts ?? ''))
        if (!placed.has(id)) continue
        const list = rowsOf.get(id)
        if (list) list.push(r)
        else rowsOf.set(id, [r])
      }
      for (const id of placed) {
        const d = liveManagerDraft(drafts[id], rowsOf.get(id) ?? [], nowMs)
        if (d) live.set(id, d)
      }
    }
    const built = await Promise.all(sessions.map(async (s) => {
        const m = meta.entries[s.id]
        const icon = icons.entries.get(iconKey(s.id))
        // 端末で開いているか（pid の生存）は毎回見る。rev には混ぜない（端末を閉じても次の行で rev が変わる）
        // 画面に出す一覧なので締切で抜けてよい（#495）。返信・レビューは待ち切る方を呼ぶ
        const out: SessionSummary = { ...s, terminal: await terminalOf(s, { soft: true }) }
        if (m) {
          out.meta = m
          if (isArchivedAt(m, s.end)) out.archived = true
        }
        if (icon) out.icon = iconUrl(s.id, icon.version)
        const n = unread.get(s.id)
        if (n) out.unread = n
        const draft = live.get(s.id)
        if (draft) out.manager_draft = draft
        out.read_at = readMarkOf(reads.marks, s.id)
        return out
      }))
    // 同じ名前のセッションを見分ける添え字（#572）。**どの口でも同じ添え字にするため、呼び出しの窓ではなく LABEL_START_DAYS の
    // 決まった窓で決める**（#578 のレビュー。一覧は 7 日・詳細は 30 日・フィードは 3 日なので、窓ごとに決めると同じセッションが
    // 見出しでは ID の頭、サイドバーでは日付になった）。start も窓の中の最初の行なので、広い窓で引くと本当の始まりになる
    const suffixes = await labelSuffixesNow(meta)
    for (const s of built) {
      const suffix = suffixes.get(s.id)
      if (suffix) s.label_suffix = suffix
    }
    // 補った返答（#614）が最後の行になるセッションは、一覧でも「ターンが終わって次を待っている」として見せる
    // （最後の発言・最後の行の読み方・終わりの時刻。要対応では下段に出て、バッジ・通知には数えない）。`turns` は触らない
    if (shown.rows !== rows) {
      const lastRecovered = new Map<string, FeedRow>()
      for (const r of shown.rows) if (r.recovered) lastRecovered.set(entityId(r.session ?? '', r.repo ?? '', String(r.ts ?? '')), r)
      for (const s of built) {
        const r = lastRecovered.get(s.id)
        if (!r) continue
        // **最後のターン完了より新しければ**最後の発言にする（最後の行とは比べない。端末のセッションは、落ちたターンの
        // 60 秒あとに `入力待ち` の行が来るので、最後の行と比べると補った返答が一覧に出ない。#627 のレビュー）。
        // 本文が空だったターン完了の行に補ったときは ts が同じ
        if (rowMs(r.ts) >= rowMs(s.last_turn_ts || undefined) || !s.last_turn_ts) {
          s.last_turn = r.ts
          s.last_turn_ts = r.ts
          s.last_text = clip(firstLine(r.text ?? ''), 120)
        }
        // 補った返答が最後の行になるときは、最後の行の読み方もターン完了にする。それより前の待ち（許可を端末で答えたあと
        // ターン完了が落ちた）は解消しているので畳む（残すと「待機中」のまま要対応に数える）
        if (rowMs(r.ts) > rowMs(s.end)) {
          s.end = r.ts
          s.last_kind = 'turn'
          s.waiting = ''
          s.idle = ''
        }
      }
    }
    // ターンは終わっているのにターン完了の行が無い（#614）。行だけで候補を絞ってから transcript を読む（候補は普段 0 件）。
    // 別のマシンのセッションは transcript が無いので見ない。時間で出る印なので、出しているものを rev に混ぜる
    const missing: string[] = []
    for (const s of built) {
      if (!stopMissingCandidate(s, nowMs) || isRemoteHost(s.host, selfHost())) continue
      // 同じセッションのターン完了の行が、別の worktree のエンティティに載っていることがある（ターンの途中で cd した。#616 のレビュー）。
      // transcript はセッション ID で引くので、どのエンティティの行でも、その入力より後にターン完了があれば落ちていない
      const session = sessionOf(s)
      const endMs = rowMs(s.end)
      if (session && rows.some((r) => r.session === session && rowMs(r.ts) >= endMs && eventKind(r.event, r.text) === 'turn')) continue
      const busy = mcpBusy(s.id)
      const closedAt = busy ? '' : ((await progress.read(s)).closed_at ?? '')
      if (stopMissing(s, { busy, closedAt, now: nowMs })) {
        s.stop_missing = true
        missing.push(s.id)
      }
    }
    return { rev: `${rev}-${meta.rev}-${icons.rev}-${reads.rev}-${[...live].map(([id, d]) => `${id}:${d.at}`).join(',')}-${missing.join(',')}-${shown.key}`, sessions: built }
  }

  /**
   * 一覧の「最後の発言」に一言を載せる。無い行はそのまま。
   * **`digest_off` のセッションには一言を載せない**（#263。切る前に作ってあるぶんも出さない。`digest.jsonl` は消さない）。
   * 次に送る文面の案は一言とは別で（#560）、`digest_off` でも載せ、**案を切っているときは載せない**
   */
  const withLastSummary = (sessions: SessionSummary[]): SessionSummary[] => {
    if (digest.store.size === 0) return sessions
    return sessions.map((s) => {
      const ts = s.last_turn_ts ?? ''
      // 2 つで組んだ一言（#713）は「何が起きたか」と「人が次にすること」に分けて載せる（画面が場所ごとに出し分ける）
      const parts = s.meta?.digest_off ? undefined : digest.partsFor(s.id, ts)
      // 次に送る文面の案（#371）。一言と同じ行に入っているので、同じところで載せる
      const nextAsk = digest.nextAskEnabled ? digest.nextAskFor(s.id, ts) : undefined
      if (!parts && !nextAsk) return s
      return { ...s, ...(parts ? { last_summary: parts.what, ...(parts.next ? { last_summary_next: parts.next } : {}) } : {}), ...(nextAsk ? { next_ask: nextAsk } : {}) }
    })
  }

  /** 一言を切っているエンティティ（#263）。行に載せるときに落とす */
  const digestOffIds = async (): Promise<Set<string>> => {
    const { entries } = await metaStore.all()
    return new Set(Object.entries(entries).filter(([, m]) => m.digest_off).map(([id]) => id))
  }

  /**
   * GET/PUT /api/settings。PUT は同一オリジンのみ。一言の入切・口・モデルは、変えたらその場で組み直す（#288。前は環境変数）。
   * 本文の送り先（SAI_DIGEST_URL）と鍵（SAI_DIGEST_API_KEY）は環境変数のままで、受けも返しもしない
   */
  /** そのセッションの返信に付く許可モード（#582）。メタにあればそれ、無ければ設定の既定。どちらも無ければ空 */
  const replyMode = async (meta: Pick<SessionMeta, 'permission_mode'> | undefined | null): Promise<string> =>
    replyModeOf(meta?.permission_mode, (await settingsStore.get()).reply_mode)
  const settingsPayload = async (): Promise<SettingsResponse> => {
    await digestReady
    const s = await settingsStore.get()
    return {
      persona: s.persona,
      linear_workspace: s.linear_workspace,
      digest: digest.enabled,
      digest_on: s.digest,
      digest_error: digest.error,
      next_ask: digest.nextAskEnabled,
      next_ask_on: nextAskOn(s),
      provider: digest.provider,
      digest_model: s.digest_model,
      model: digest.model,
      jev_on: s.jev,
      jev_ready: jevRisk.ready,
      jev_auto: s.jev_auto,
      paste_to_file: s.paste_to_file,
      reply_mode: s.reply_mode,
      send_across: s.send_across,
      send_across_projects: await knownProjects(),
    }
  }
  /**
   * 記録で知っているリポジトリ（#747。別のリポジトリへ送る組に選べるもの）。名前の順。送信の判定（`agentFrom()`）と同じ
   * `sessionsWithMeta()` の `project`（古い行は cwd から埋めたもの）を使う。**読めなくても設定の応答は落とさない**（空で返す）
   */
  const knownProjects = async (): Promise<string[]> => {
    try {
      const { sessions } = await sessionsWithMeta(QUEUE_DAYS)
      return [...new Set(sessions.map((x) => x.project).filter(Boolean))].sort()
    } catch {
      return []
    }
  }

  /**
   * POST /api/prs/<owner>/<repo>/<番号>/review（#526）。**SAI が GitHub に書く唯一の口**。同一オリジンは呼ぶ側で確かめてある。
   * 宛先は記録で知っているリポジトリから引き、**いまの PR を読み直して** head が画面の読んだ SHA と同じか・行コメントの行が
   * いまの差分に同じ中身であるかを確かめてから、GitHub に渡す形をサーバで組み立てる（画面の位置をそのまま渡さない）。
   * 送った・送れなかったことは reply.log に 1 行
   */
  const postPrReview = async (req: IncomingMessage, res: ServerResponse, known: string[], rest: string) => {
    const parts = rest.split('/')
    const [owner = '', name = '', n = ''] = parts
    const repo = parts.length === 3 ? pickKnownRepo(known, `${owner}/${name}`) : ''
    if (!repo || !isPrNumber(n)) return error(res, 404, 'not found')
    if (!prs.available) return error(res, 404, 'gh を使わない設定です（SAI_GH=0）')
    let raw: unknown
    try {
      raw = await readJson(req, MAX_PR_REVIEW_BYTES)
    } catch (err) {
      return error(res, 400, err instanceof Error ? err.message : 'bad body')
    }
    const parsed = parseReviewRequest(raw)
    if (!parsed.ok) return error(res, 400, parsed.error)
    const r = parsed.req
    const [login, view] = await Promise.all([prs.viewer(), prs.view(repo, Number(n))])
    if (!login) return error(res, 503, 'gh にログインしていないので投稿できません（gh auth login）')
    if (!view) return error(res, 502, 'gh で PR を読めませんでした')
    if (view.pr.state !== 'OPEN') return error(res, 409, 'この PR はもう開いていません')
    if (view.pr.head_sha !== r.commit_id) {
      const payload: ReplyError = { error: 'PR が読んだあとに進みました。読み直してから送ってください', code: 'head_moved' }
      return json(res, payload, 409)
    }
    if (r.event !== 'COMMENT' && login.toLowerCase() === view.pr.author.toLowerCase()) {
      return error(res, 400, '自分の PR には Comment しか送れません')
    }
    if (r.comments.length > 0 && view.patch === null) return error(res, 502, '差分を読めないので行コメントを確かめられません')
    const built = githubReview(r, view.patch === null ? [] : parseUnifiedDiff(view.patch))
    if (!built.ok) {
      const where = built.stale.map((i) => `${r.comments[i]?.path}:${r.comments[i]?.line}`).join('、')
      const payload: ReplyError = { error: `行が変わった・見当たらないコメントがあります（${where}）。外すか全体のコメントに移してください`, code: 'lines_moved' }
      return json(res, payload, 409)
    }
    const result = await prs.postReview(repo, Number(n), built.review)
    // 差分ボタン横のリンクが持つ承認の状態（GhPr の 60 秒のキャッシュ）も引き直す（#636）
    if (result.ok) pr.forget?.()
    const log = `--- ${new Date().toISOString()} GitHub へレビュー ${repo}#${n} ${r.event} 行コメント ${built.review.comments.length} 件 commit ${r.commit_id.slice(0, 12)} (${login})`
    await appendFile(join(store.directory, 'reply.log'), result.ok ? `${log} → ${result.url || '(URL 不明)'}\n` : `${log} 失敗: ${result.error}\n`).catch(() => {})
    if (!result.ok) return error(res, 502, `GitHub に投稿できませんでした: ${result.error}`)
    const payload: PrReviewResponse = { ok: true, url: result.url, event: r.event }
    return json(res, payload)
  }

  /**
   * POST /api/digest/feedback（#346）。一言が変だと言われたら、そのときの一言・口・性格と一緒に
   * `~/.agent-feed/digest-feedback.jsonl` に残す。溜めたものは規則を直すときの材料と回帰テストの素材にする。
   * 使われたかの合図（#446。詳細を開いた `opened`・案を受け取った `next_ask_accepted`）も同じ口・同じファイルに溜める。
   * **一言そのものは鍵から引く**（画面から来た文字列は信じない）。**同一オリジンのみ**（画面から叩くので、返信と同じ）
   */
  const postDigestFeedback = async (req: IncomingMessage, res: ServerResponse) => {
    if (isCrossOrigin(req)) return error(res, 403, 'cross-origin request rejected')
    let body: unknown
    try {
      body = await readJson(req, MAX_SETTINGS_BYTES)
    } catch (err) {
      return error(res, 400, err instanceof Error ? err.message : 'bad body')
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)) return error(res, 400, 'body はオブジェクトで送ってください')
    const b = body as Partial<DigestFeedbackRequest>
    if (typeof b.key !== 'string' || !b.key) return error(res, 400, 'key（一言の鍵）を送ってください')
    if (!isDigestFeedbackReason(b.reason) && !isDigestUsageReason(b.reason)) return error(res, 400, 'reason が不明です（shared/digestFeedback.ts にある id を送ってください）')
    // 使われたかの合図（#446）に「こうしてほしい」は付かない（画面は送らない。来ても残さない）
    const note = typeof b.note === 'string' && !isDigestUsageReason(b.reason) ? b.note.trim() : ''
    if ([...note].length > DIGEST_NOTE_MAX) return error(res, 400, `note は ${DIGEST_NOTE_MAX} 文字までです`)
    await digestReady
    const entry = digest.store.get(b.key)
    // 案を受け取った（#446）: その行に案があること。一言は無くてよい（案だけ作った行。#560）。**案も鍵から引く**
    if (b.reason === 'next_ask_accepted') {
      if (!entry?.next_ask) return error(res, 404, 'その案が見つかりません（作り直されたか、まだ届いていません）')
    } else if (!entry?.summary) {
      // 案だけ作った行（summary が空。#560）には一言が無い
      return error(res, 404, 'その一言が見つかりません（作り直されたか、まだ届いていません）')
    }
    await feedback.load()
    await feedback.append({
      key: b.key,
      summary: entry.summary,
      model: entry.model,
      persona: entry.persona,
      reason: b.reason,
      ...(b.reason === 'next_ask_accepted' && entry.next_ask ? { next_ask: entry.next_ask } : {}),
      ...(note ? { note } : {}),
      ts: new Date().toISOString(),
    })
    const payload: DigestFeedbackResponse = { ok: true, count: feedback.size }
    return json(res, payload)
  }

  const putSettings = async (req: IncomingMessage, res: ServerResponse) => {
    if (isCrossOrigin(req)) return error(res, 403, 'cross-origin request rejected')
    let body: unknown
    try {
      body = await readJson(req, MAX_SETTINGS_BYTES)
    } catch (err) {
      return error(res, 400, err instanceof Error ? err.message : 'bad body')
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)) return error(res, 400, 'body はオブジェクトで送ってください')
    // 省略したキーは据え置き。どれか 1 つ以上
    const b = body as Partial<SettingsRequest>
    const patch: Partial<Settings> = {}
    if (b.persona !== undefined) {
      if (!isPersonaId(b.persona)) return error(res, 400, 'persona が不明です（shared/persona.ts にある id を送ってください）')
      patch.persona = b.persona
    }
    if (b.linear_workspace !== undefined) {
      const ws = typeof b.linear_workspace === 'string' ? b.linear_workspace.trim().toLowerCase() : b.linear_workspace
      if (!isLinearWorkspace(ws)) return error(res, 400, 'linear_workspace は URL の linear.app/<workspace>/ の部分（小文字の英数字と -）で送ってください')
      patch.linear_workspace = ws
    }
    if (b.digest !== undefined) {
      if (typeof b.digest !== 'boolean') return error(res, 400, 'digest は true か false で送ってください')
      patch.digest = b.digest
    }
    if (b.digest_provider !== undefined) {
      if (!isDigestProvider(b.digest_provider)) return error(res, 400, 'digest_provider は claude か openai で送ってください')
      patch.digest_provider = b.digest_provider
    }
    if (b.digest_model !== undefined) {
      const model = typeof b.digest_model === 'string' ? b.digest_model.trim() : b.digest_model
      if (!isDigestModel(model)) return error(res, 400, 'digest_model はモデル名（英数字で始まり、英数字と . _ : / - [ ] だけ、64 文字まで。空なら口の既定）で送ってください')
      patch.digest_model = model
    }
    if (b.next_ask !== undefined) {
      if (typeof b.next_ask !== 'boolean') return error(res, 400, 'next_ask は true か false で送ってください')
      patch.next_ask = b.next_ask
    }
    if (b.jev !== undefined) {
      if (typeof b.jev !== 'boolean') return error(res, 400, 'jev は true か false で送ってください')
      patch.jev = b.jev
      // Jev を切ったら自動も切（隠れて残った閾値で、入に戻した瞬間に自動で答えない）
      if (!b.jev) patch.jev_auto = 0
    }
    if (b.paste_to_file !== undefined) {
      if (typeof b.paste_to_file !== 'boolean') return error(res, 400, 'paste_to_file は true か false で送ってください')
      patch.paste_to_file = b.paste_to_file
    }
    if (b.reply_mode !== undefined) {
      // セッションのメタ（mergeMeta）と同じ一覧。画面から選べないモードは既定にもできない
      if (b.reply_mode !== '' && !isReplyPermissionMode(b.reply_mode)) return error(res, 400, `reply_mode に使えるのは ${REPLY_MODES.join(' / ')} だけです（空文字で「決めない」）`)
      patch.reply_mode = b.reply_mode
    }
    if (b.send_across_add !== undefined || b.send_across_remove !== undefined) {
      // 別のリポジトリへ送ってよい組（#747）。**1 つずつ足す・外す**（丸ごと置き換える形は受けない）。足せるのは記録で知っているリポジトリだけ。
      // いま持っている組は検査し直さない（片方が記録の窓から出た古い組があっても、ほかの組を足す・外すのを止めない）
      let pairs: SendAcrossPair[] | string = (await settingsStore.get()).send_across
      if (b.send_across_remove !== undefined) pairs = removePair(pairs, b.send_across_remove)
      if (typeof pairs !== 'string' && b.send_across_add !== undefined) pairs = addPair(pairs, b.send_across_add, await knownProjects())
      if (typeof pairs === 'string') return error(res, 400, pairs)
      patch.send_across = pairs
    }
    if (b.jev_auto !== undefined) {
      if (!isJevAuto(b.jev_auto)) return error(res, 400, 'jev_auto は 0（しない）か 0.5〜1 の数で送ってください')
      patch.jev_auto = b.jev_auto
    }
    if (Object.keys(patch).length === 0) return error(res, 400, 'persona / linear_workspace / digest / next_ask / digest_provider / digest_model / paste_to_file / reply_mode / send_across_add / send_across_remove / jev / jev_auto のどれかを送ってください')
    // 起動時の組み立て（settings.json の読み込み）が済んでから書く。後から古い値で組み直されないように
    await digestReady
    const saved = await settingsStore.set(patch)
    // 組を外したら、もう相手の預かりに並んでいる、その向きのメッセージも取り消す（#747。外したあとに相手で回り出さない）
    if (patch.send_across !== undefined) await cancelCrossQueued(saved.send_across)
    if (patch.digest !== undefined || patch.next_ask !== undefined || patch.digest_provider !== undefined || patch.digest_model !== undefined) digest.configure(saved)
    // 閾値を入れた・下げたら、預かっている分にすぐ効かせる
    if (patch.jev_auto !== undefined || patch.jev !== undefined) void jevAutoTick()
    return json(res, await settingsPayload())
  }

  /**
   * 相手の預かり（#305）に並んでいる `sai_send` のうち、**もう許されていない向きでリポジトリをまたぐもの**を取り消す（#747）。
   * 組を外した直後に呼ぶ。相手でもう回っているターンは止めない（#311 と同じ線）。送り元の側の預かり（#727）は `drainBacklog()` が
   * 送る直前に同じ判定で止める
   */
  const cancelCrossQueued = async (pairs: readonly SendAcrossPair[]): Promise<void> => {
    try {
      const { sessions } = await sessionsWithMeta(QUEUE_DAYS)
      const projectOf = new Map(sessions.map((x) => [x.id, x.project]))
      const cancelled = queue.removeWhere((to, item) => {
        const message = item.origin ? agents.get(item.origin) : undefined
        if (!message) return false
        const from = projectOf.get(message.from) ?? ''
        const dest = projectOf.get(to) ?? ''
        return Boolean(from && dest && from !== dest && !mayCross(pairs, from, dest))
      })
      if (cancelled > 0) await appendFile(join(store.directory, 'reply.log'), `--- ${new Date().toISOString()} 別のリポジトリへ送る組を外したので、相手の預かりに並んでいたメッセージ ${cancelled} 件を取り消した\n`).catch(() => {})
    } catch {
      // 一覧が読めなければ何もしない（組はもう外れているので、新しい送信は通らない）
    }
  }

  const send = (res: ServerResponse, status: number, body: Buffer | string, type: string) => {
    const buf = typeof body === 'string' ? Buffer.from(body, 'utf-8') : body
    res.writeHead(status, {
      'Content-Type': type,
      'Content-Length': buf.length,
      'Cache-Control': 'no-store',
    })
    res.end(buf)
  }
  const json = (res: ServerResponse, payload: unknown, status = 200) =>
    send(res, status, JSON.stringify(payload), 'application/json; charset=utf-8')
  const error = (res: ServerResponse, status: number, message: string) => json(res, { error: message }, status)
  /**
   * rev を持つ応答（一覧・詳細・フィード）。**前に渡した rev と同じなら本文を送らず 304**（#592。3 秒のポーリングは
   * 変わっていないことの方が多く、詳細は 0.2〜0.4MB を毎回送っていた）。画面は rev が同じなら元々描き直さないので、
   * 見えるものは変わらない。`Cache-Control: no-store` のまま（ブラウザのキャッシュには載せず、画面が `If-None-Match` を自分で付ける）。
   * ETag は rev のハッシュ（rev には日本語や区切りの記号が入るので、そのままヘッダに載せない）
   */
  const jsonByRev = (req: IncomingMessage, res: ServerResponse, payload: { rev: string }) => {
    const etag = `"${createHash('sha1').update(payload.rev).digest('hex').slice(0, 20)}"`
    if (req.headers['if-none-match'] === etag) {
      res.writeHead(304, { ETag: etag, 'Cache-Control': 'no-store' })
      res.end()
      return
    }
    const buf = Buffer.from(JSON.stringify(payload), 'utf-8')
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': buf.length, 'Cache-Control': 'no-store', ETag: etag })
    res.end(buf)
  }

  /**
   * 読み終えた画像を配る（本文のパス・transcript・Codex の生成画像の 3 つの口）。`?thumb=1` なら軽い版（#589）: しきい値未満は元のまま、
   * 縮めたら JPEG（透過があれば PNG）、縮められなければ 503 と `X-SAI-Thumb: unavailable`（画面は押すまで元を読まない）。
   * ライトボックスとダウンロードは `?thumb=1` を付けないので元の画像のまま
   */
  const sendImage = async (req: IncomingMessage, res: ServerResponse, img: { bytes: Buffer; type: IconType; name: string; etag: string }, q: URLSearchParams) => {
    const download = q.get('download') === '1'
    const wantThumb = q.get('thumb') === '1' && !download
    // 軽い版の ETag は元の ETag から作る（元が変われば軽い版も変わる）。`t2` は帯の軽い版の大きさを変えたとき（#709）に上げた
    // （上げないと、ブラウザが持っている長辺 512px の帯が 304 でそのまま使われる）
    const etag = wantThumb && img.bytes.length >= THUMB_MIN_BYTES ? img.etag.replace(/^"/, '"t2-') : img.etag
    if (req.headers['if-none-match'] === etag) {
      res.writeHead(304, { ETag: etag, 'Cache-Control': 'private, no-cache' })
      res.end()
      return
    }
    const t = wantThumb ? await thumbs.thumb(img) : ({ kind: 'original' } as const)
    if (t.kind === 'unavailable') {
      res.writeHead(503, { 'Cache-Control': 'no-store', 'X-SAI-Thumb': 'unavailable', 'X-SAI-Image-Bytes': img.bytes.length, 'Content-Length': 0 })
      res.end()
      return
    }
    const out = t.kind === 'thumb' ? { ...img, bytes: t.bytes, type: t.type, etag } : img
    res.writeHead(200, imageHeaders(out, download))
    res.end(req.method === 'HEAD' ? undefined : out.bytes)
  }

  /** dist/ の中だけを配る。外に出る path は 404 */
  const sendStatic = async (res: ServerResponse, relative: string) => {
    const target = resolve(distRoot, relative)
    if (target !== distRoot && !target.startsWith(distRoot + sep)) return error(res, 404, 'not found')
    let body: Buffer
    try {
      body = await readFile(target)
    } catch {
      if (relative === 'index.html') return send(res, 200, NO_DIST, 'text/html; charset=utf-8')
      return error(res, 404, 'not found')
    }
    send(res, 200, body, MIME[extname(target)] ?? 'application/octet-stream')
  }

  /** POST /api/sessions/<id>/reply。セッションを再開して1ターン回すのを投げっぱなしにし、202 を返す */
  const reply = async (req: IncomingMessage, res: ServerResponse, id: string, days: number) => {
    if (isCrossOrigin(req)) return error(res, 403, 'cross-origin request rejected')
    let body: unknown
    try {
      body = await readJson(req, MAX_REPLY_BYTES)
    } catch (err) {
      return error(res, 400, err instanceof Error ? err.message : 'bad body')
    }
    const typedText = typeof (body as ReplyRequest | null)?.text === 'string' ? (body as ReplyRequest).text.trim() : ''
    // 添える画像。**画面から来た絶対パスは信じない**。そのセッションの置き場のものだけを通してから CLI に渡す
    const wanted = (body as ReplyRequest | null)?.attachments
    if (wanted !== undefined && (!Array.isArray(wanted) || wanted.some((p) => typeof p !== 'string'))) {
      return error(res, 400, 'attachments は文字列の配列で送ってください')
    }
    const asked = (wanted ?? []) as string[]
    if (asked.length > ATTACHMENT_MAX_COUNT) return error(res, 400, `添付は ${ATTACHMENT_MAX_COUNT} 個までです`)
    const attached: string[] = []
    const names = new Map<string, string>()
    for (const p of asked) {
      const resolved = attachmentStore.resolvePath(id, p)
      if (!resolved) return error(res, 400, 'このセッションに預けた添付ではありません')
      attached.push(resolved)
      // 画像以外（#608）は元の名前を行に添える。名前は置いたときに隣へ書いたもの（リクエストからは受けない）
      if (!isImageAttachmentPath(resolved)) names.set(resolved, await attachmentStore.labelOf(resolved))
    }
    // 本文の末尾にパスを足す（Claude はこれを Read で読む。Codex は -i でも渡すが、記録と自分バブルのために本文にも）
    const text = withAttachments(typedText, attached, names)
    // **画像を受ける口（Codex の `-i`・app-server の localImage・OpenCode の `-f`）へ渡すのは画像だけ**。
    // 文字のファイルと PDF は本文のパスで渡す（エージェントが自分で読む）
    const attachments = attached.filter(isImageAttachmentPath)
    if (!text) return error(res, 400, 'text is required')
    const replaceTyped = (body as ReplyRequest).replace_typed === true
    const forceProcess = (body as ReplyRequest).via === 'process'
    const wantQueue = (body as ReplyRequest).queue === true
    const wantSteer = (body as ReplyRequest).steer === true
    const wantCompact = (body as ReplyRequest).compact === true
    // 別のセッションの画面の、返答のバブルの下から送った（#700）。形だけ見て、覚えるかは受け付けたあとに決める
    const from = (body as ReplyRequest).sent_from
    if (from !== undefined && (!from || typeof from !== 'object' || typeof from.id !== 'string' || typeof from.anchor !== 'string' || from.id.length > 400 || from.anchor.length > 64)) {
      return error(res, 400, 'sent_from の形が違います')
    }
    const sentAt = new Date().toISOString()
    const out = await launch(id, text, attachments, { days, replaceTyped, forceProcess, url: selfUrl(req), queue: wantQueue, steer: wantSteer, ...(wantCompact ? { compact: true } : {}) })
    // 人が自分で送ったら、そのセッションのループは一時停止する（#634。割り込みを優先。再開は人が押す）
    if (out.status === 202) await pauseLoop(id, '人がこのセッションに送ったので一時停止しました')
    // 送り元の画面に「送った」の 1 行と、相手のそのあとの返答を出すために覚える（#700）。送り元がこの相手に
    // メッセージを送ったことがあるときだけ（`follow()` が見る）。送り方は変えず、送り元の会話にも足さない
    if (out.status === 202 && from) agents.follow(from.id, id, typedText || text, from.anchor, sentAt)
    return json(res, out.body, out.status)
  }

  /**
   * Codex / OpenCode のセッションを会話ごと分岐して、分岐先で最初の 1 ターンを回す（#405 / #398。`POST /api/sessions/<id>/fork`）。
   * **同一オリジンのみ**。受け取るのは最初の指示だけで、**`cwd`・モデル・権限はリクエストから受けない**（cwd は元のセッションの行から、
   * モデルは元のセッションのメタから）。新しい ID は app-server（`thread/fork`）か `opencode serve`（`/session/<id>/fork`）が決め、
   * SAI は行を起こさない（分岐先の行は、回した 1 ターンの `notify` / プラグインが書く）。git も worktree も触らない。
   * 元のセッションが動いている・ほかで開かれているあいだは断る（同じ作業ディレクトリで 2 本が同時に動く）
   */
  const fork = async (req: IncomingMessage, res: ServerResponse, id: string, days: number) => {
    if (isCrossOrigin(req)) return error(res, 403, 'cross-origin request rejected')
    let body: unknown
    try {
      body = await readJson(req, MAX_REPLY_BYTES)
    } catch (err) {
      return error(res, 400, err instanceof Error ? err.message : 'bad body')
    }
    const asked = (body && typeof body === 'object' ? body : {}) as Partial<ForkSessionRequest>
    const text = typeof asked.text === 'string' ? asked.text.trim() : ''
    if (!text) return error(res, 400, 'text is required')
    const { sessions } = await store.sessions(days)
    const session = sessions.find((s) => s.id === id)
    if (!session) return error(res, 404, 'session not found in window')
    // 会話の分岐を持っているのは Codex と OpenCode（#398）だけ（Claude の `--fork-session` は別の話）
    const opencode = session.agent === 'opencode'
    if (session.agent !== 'codex' && !opencode) return error(res, 400, '分岐できるのは Codex と OpenCode のセッションだけです')
    if (opencode) {
      // OpenCode は長寿命の serve の中でだけ分ける（新しいセッションと同じ。一発の `opencode run` には落とさない）
      if (!opencodeServerEnabled) return error(res, 400, 'SAI_OPENCODE_SERVER=0 のときは分岐できません')
      if (!opencodeApp.fork) return error(res, 400, 'この SAI では分岐できません')
    } else {
      if (!codexAppEnabled) return error(res, 400, 'SAI_CODEX_APP_SERVER=0 のときは分岐できません')
      if (!codexApp.fork) return error(res, 400, 'この SAI では分岐できません')
    }
    const blocked = replyBlockedReason(session, selfHost())
    if (blocked) return error(res, 400, blocked)
    const rows = (await rowsNow(days)).filter((r) => entityId(r.session ?? '', r.repo ?? '', String(r.ts ?? '')) === id)
    const raw = rows[rows.length - 1]?.session ?? ''
    if (!raw) return error(res, 400, 'session id missing in rows')
    const cwd = session.cwd
    try {
      if (!cwd || !(await stat(cwd)).isDirectory()) throw new Error('not a directory')
    } catch {
      return error(res, 400, `cwd が見つかりません: ${cwd || '(空)'}`)
    }
    // 分岐先は同じ作業ディレクトリで動く。元が動いている・預かりが残っているあいだは始めない
    if (run.running(id) || codexApp.running(id) || opencodeApp.running(id) || typed.running(id) || launching.has(id) || queue.size(id) > 0) {
      return error(res, 409, '元のセッションがまだ処理中です。終わってから分岐してください')
    }
    // ほかで開いているスレッドも同じ理由で断る（レビュー・返信の振り分けと同じ 2 つを見る。#430）
    if (await terminalOf(session)) return error(res, 400, '端末で開いているセッションは分岐できません（端末を閉じてから分岐してください）')
    if (!opencode && (await codexHeldElsewhere(session, raw))) return error(res, 400, 'ほかのところ（端末・ほかのアプリ）で開いているセッションは分岐できません')
    // 分岐を始めているあいだは、元のセッションを「起動中」にしておく（返信・レビュー・メッセージと同じ `launching`）。
    // `thread/fork` と最初の `turn/start` を待っている間に元へ返信が来ても、同じ作業ディレクトリで 2 本を同時に始めない。
    // 上の検査（`launching.has`）からここまで await を挟まないので、押し直し・2 枚の画面から同時に来ても 2 つは作らない
    launching.add(id)
    try {
      // OpenCode は、SAI が数えていないターン（立て直す前に起こした・serve の側で回っている）も見る（#398 のレビュー）。
      // 立っている serve に聞くだけで、このために serve は起こさない。**自分の端末で開いた TUI（別のプロセス）のターンは見えない**。
      // `launching` に入れてから聞く（待っている間に来た 2 本目の分岐・返信を、上の検査で止める）
      if (opencode && (await opencodeApp.turnRunning?.(raw, cwd))) return error(res, 409, '元のセッションがまだ処理中です。終わってから分岐してください')
      // 分岐先のメタ: 分岐元を残し、モデルと表示名（付いていれば「（分岐）」を足して）を引き継ぐ。値は保存済みなので検査は済んでいる
      const old = await metaStore.get(id)
      const meta: SessionMeta = { forked_from: id }
      if (old?.model) meta.model = old.model
      // 長い表示名は元の名前のほうを切る（印が切れると元と見分けが付かない）。サロゲートペアの途中では切らない
      if (old?.name) meta.name = `${old.name.slice(0, META_NAME_MAX - FORK_NAME_SUFFIX.length).replace(/[\uD800-\uDBFF]$/, '')}${FORK_NAME_SUFFIX}`
      if (opencode) return await startOpencodeSession(res, session, cwd, text, meta, { session: () => opencodeApp.fork!(raw, cwd), label: `OpenCode のセッションを分岐（POST /session/${raw}/fork → prompt_async）`, what: 'OpenCode のセッションを分岐できませんでした' })
      return await startCodexSession(res, session, cwd, text, meta, { thread: () => codexApp.fork!(raw), label: `Codex のセッションを分岐（thread/fork ${raw} → turn/start）` })
    } finally {
      launching.delete(id)
    }
  }

  /**
   * 差分のレビューを Codex に頼む（#403。`POST /api/sessions/<id>/review`）。**同一オリジンのみ**（返信と同じ扱い）。
   * 受け取るのは対象の種類だけで、**`cwd` もブランチ名もリクエストからは受けない**（cwd は行から、
   * 比べる相手は差分ビューアと同じ `resolveBase()` で決める）。結果は普通のターン完了の行として届く
   */
  const review = async (req: IncomingMessage, res: ServerResponse, id: string, days: number) => {
    if (isCrossOrigin(req)) return error(res, 403, 'cross-origin request rejected')
    let body: unknown
    try {
      body = await readJson(req, MAX_REPLY_BYTES)
    } catch (err) {
      return error(res, 400, err instanceof Error ? err.message : 'bad body')
    }
    const target = (body as ReviewRequest | null)?.target
    if (target !== 'uncommittedChanges' && target !== 'baseBranch') {
      return error(res, 400, 'target は uncommittedChanges か baseBranch です')
    }
    const { sessions } = await store.sessions(days)
    const session = sessions.find((s) => s.id === id)
    if (!session) return error(res, 404, 'session not found in window')
    // レビューの口があるのは Codex の app-server だけ（Claude は本文に `/review` を送る別の話）
    if (session.agent !== 'codex') return error(res, 400, 'レビューを頼めるのは Codex のセッションだけです')
    if (!codexAppEnabled) return error(res, 400, 'SAI_CODEX_APP_SERVER=0 のときはレビューを頼めません')
    if (!codexApp.review) return error(res, 400, 'この SAI ではレビューを頼めません')
    const blocked = replyBlockedReason(session, selfHost())
    if (blocked) return error(res, 400, blocked)
    const rows = (await rowsNow(days)).filter((r) => entityId(r.session ?? '', r.repo ?? '', String(r.ts ?? '')) === id)
    const raw = rows[rows.length - 1]?.session ?? ''
    if (!raw) return error(res, 400, 'session id missing in rows')
    const cwd = session.cwd
    try {
      if (!cwd || !(await stat(cwd)).isDirectory()) throw new Error('not a directory')
    } catch {
      return error(res, 400, `cwd が見つかりません: ${cwd || '(空)'}`)
    }
    // レビューも 1 本のターンなので、返信と同じ歯止めに乗せる。**預かりには回さない**
    // （預かり（#305）が持てるのは本文だけで、レビューの対象を持ち越せない。押し直せばよい）
    if (run.running(id) || codexApp.running(id) || opencodeApp.running(id) || launching.has(id) || queue.size(id) > 0) {
      return error(res, 409, 'このセッションはまだ前の返信を処理中です')
    }
    // **ほかで開いているスレッドは resume しない**（#430）。`review/start` の前に `thread/resume` するので、
    // 生きている TUI や別の app-server が握っている会話を SAI の app-server が奪ってしまう。返信なら同じ判定で
    // 端末に打ち込むか queue に回せる（#329）が、レビューは対象（未コミット / ブランチ）を持ち越す口が無いので断る。
    // 端末のペインは先に見る（0.154.0 の TUI は lock を開かないので、lock だけでは取りこぼす。#417）
    if (await terminalOf(session)) return error(res, 400, '端末で開いているセッションにはレビューを頼めません（端末の方で頼んでください）')
    if (await codexHeldElsewhere(session, raw)) return error(res, 400, 'ほかのところ（端末・ほかのアプリ）で開いているセッションにはレビューを頼めません')
    // 比べる相手は差分ビューアと同じ選び方（#289）。見つからないブランチを渡すとターンを 1 本無駄にする
    let base = ''
    if (target === 'baseBranch') {
      base = await resolveBase(git, cwd).catch(() => '')
      if (!base) return error(res, 400, '比べる相手のブランチが見つかりません')
    }
    const text = target === 'baseBranch' ? `差分のレビュー（${base} との差分）` : '差分のレビュー（未コミットの変更）'
    const log = join(store.directory, 'reply.log')
    await appendFile(log, `--- ${new Date().toISOString()} ${id} Codex にレビューを頼む（review/start ${target}${base ? ` ${base}` : ''}) (cwd ${cwd})\n`).catch(() => {})
    launching.add(id)
    try {
      await codexApp.review({ id, threadId: raw, cwd, model: (await metaStore.get(id))?.model, text, target, base })
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      const hint = code === 'ENOENT' ? 'codex が見つかりません（サーバを起動した環境の PATH に codex があるか確かめてください）' : ''
      const message = hint || `Codex にレビューを頼めませんでした: ${err instanceof Error ? err.message : String(err)}`
      await appendFile(log, `${message}\n`).catch(() => {})
      return error(res, 500, message)
    } finally {
      launching.delete(id)
    }
    const payload: ReviewResponse = { accepted: true, id, session: raw, cwd, target, ...(base ? { base } : {}) }
    return json(res, payload, 202)
  }

  /**
   * 新しいセッションを始める場所（#319）。`worktree` が空なら `from` の cwd（git の作業ツリーの中のときだけ）、
   * あれば `from` と同じリポジトリの worktree のうち、その鍵のもの。`git worktree list` は覚えたものを使わず読み直す
   */
  const startPlace = async (from: SessionSummary, worktree: string): Promise<{ cwd: string; repo: string } | { reason: string }> => {
    if (!from.cwd) return { reason: 'cwd が見つかりません: (空)' }
    let cwd: string
    try {
      cwd = await realpath(from.cwd)
      if (!(await stat(cwd)).isDirectory()) throw new Error('not a directory')
    } catch {
      return { reason: `cwd が見つかりません: ${from.cwd}` }
    }
    const trees = await worktrees.usable(cwd, true)
    const own = trees ? treeOf(cwd, trees) : null
    if (!trees || !own) return { reason: `git の作業ツリーではないので、ここでは始められません: ${from.cwd}` }
    if (!worktree) return { cwd: from.cwd, repo: from.repo }
    const sibling = trees.find((t) => t.key === worktree)
    if (!sibling) return { reason: 'その worktree はもうありません（一覧を開き直してください）' }
    return { cwd: sibling.path, repo: basename(sibling.path) }
  }

  /**
   * `GET /api/workspaces`（#319）。記録にある cwd（このマシンのもの）ごとに一番新しいセッションを取り、
   * **git の作業ツリーの中にあるものだけ**を `recorded` に、同じリポジトリの記録の無い worktree を `siblings` に並べる。
   * 兄弟の `from` は、そのリポジトリで一番新しいセッション（新しい順に見るので最初に当たったもの）
   */
  const workspacesOf = async (sessions: readonly SessionSummary[]): Promise<WorkspacesResponse> => {
    const newest = new Map<string, SessionSummary>()
    for (const s of sessions) {
      if (!s.cwd || isRemoteHost(s.host, selfHost())) continue
      const seen = newest.get(s.cwd)
      if (!seen || Date.parse(s.end) > Date.parse(seen.end)) newest.set(s.cwd, s)
    }
    const ordered = [...newest.values()].sort((a, b) => Date.parse(b.end) - Date.parse(a.end))
    const read = await Promise.all(
      ordered.map(async (s) => {
        const real = await realpath(s.cwd).catch(() => '')
        const trees = real ? await worktrees.usable(real) : null
        return { s, real, trees, own: real && trees ? treeOf(real, trees) : null }
      }),
    )
    const recorded: string[] = []
    const covered = new Set<string>()
    for (const r of read) {
      if (!r.own) continue
      recorded.push(r.s.id)
      // 記録が worktree の下のディレクトリ（`/repo/server`）でも、その worktree（`/repo`）は記録のあるものとして扱う
      // （#584 のレビュー。cwd で覚えていたら、同じ worktree が「記録なし」としてもう 1 度並んだ）
      covered.add(r.own.path)
    }
    const siblings: SiblingWorktree[] = []
    const offered = new Set<string>()
    for (const r of read) {
      if (!r.own || !r.trees) continue
      for (const t of r.trees) {
        if (covered.has(t.path) || offered.has(t.path)) continue
        offered.add(t.path)
        siblings.push({ from: r.s.id, worktree: t.key, cwd: t.path, repo: basename(t.path), branch: t.branch, project: r.s.project })
      }
    }
    return { recorded, siblings }
  }

  /**
   * POST /api/sessions/new（#314）。SAI の画面から新しいセッションを始めるのを投げっぱなしにし、202 を返す。
   * **パスは受け取らない**: `from`（既存のセッション）の `cwd` を使う。返信と同じく、同一オリジンの検査が破られても
   * 走る場所を記録にある worktree に閉じる。ID は `--session-id` でサーバが決めるので、最初の行が届く前から
   * エンティティID が分かり、処理中（`replying`）・許可の配線（`SAI_ENTITY`）・メタを返信と同じ鍵で扱える。
   * 行が 1 本も届かないうちに落ちても、`replying` は一覧に居ないセッションの分も載せるので画面に理由が出る。
   * **Codex は `thread/start` で同じことができる**（#401）: 返る thread id がそのまま記録の `session` になるので、
   * Claude の `--session-id` と同じく最初の行より前に鍵が決まる（実測）。作ったスレッドは rollout がまだ無いので、
   * 最初のターンだけ `thread/resume` を飛ばす（`CodexAppServer` 側でやる）
   */
  /** 引き継ぎで始めている最中の（前のセッション, 引き継ぎの行）（#442）。同時に 2 本来たときに 2 つ始めない */
  const handoffStarting = new Set<string>()
  const startSession = async (req: IncomingMessage, res: ServerResponse, days: number) => {
    if (isCrossOrigin(req)) return error(res, 403, 'cross-origin request rejected')
    let body: unknown
    try {
      body = await readJson(req, MAX_REPLY_BYTES)
    } catch (err) {
      return error(res, 400, err instanceof Error ? err.message : 'bad body')
    }
    const asked = (body && typeof body === 'object' ? body : {}) as Partial<NewSessionRequest>
    // 引き継いで始める（#442）。最初の入力は body からではなく、`from` の最後のターン完了の行（引き継ぎの返答）から取る
    const handoff = asked.handoff === true
    let text = typeof asked.text === 'string' ? asked.text.trim() : ''
    if (!text && !handoff) return error(res, 400, 'text is required')
    if (typeof asked.from !== 'string' || !asked.from) return error(res, 400, 'from（どの worktree で始めるか）が要ります')
    const agent = asked.agent ?? 'claude'
    if (agent !== 'claude' && agent !== 'codex' && agent !== 'opencode') return error(res, 400, '始められるのは claude か codex か opencode です')
    if (agent === 'codex' && !(codexAppEnabled && codexApp.startThread)) {
      return error(res, 400, 'Codex のセッションを始めるには app-server が要ります（SAI_CODEX_APP_SERVER=0 では始められません）')
    }
    // **`opencode run` には落とさない**（#452）。run は許可を人に聞かずその場で自動 reject するので、
    // 始めたターンが許可ひとつで無駄になり、#421 の「画面から答える」も当たらない
    if (agent === 'opencode' && !(opencodeServerEnabled && opencodeApp.startSession)) {
      return error(res, 400, 'OpenCode のセッションを始めるには serve が要ります（SAI_OPENCODE_SERVER=0 では始められません）')
    }
    // モデルと許可モードは PUT .../meta と同じ検査（mergeMeta）を通してから、新しいセッションのメタに書く
    const { meta, error: reason } = mergeMeta({}, { model: asked.model ?? '', permission_mode: asked.permission_mode ?? '' })
    if (reason) return error(res, 400, reason)
    // `claude --bg` で始める（#462）。デーモンの口は Claude にしか無い
    const inBackground = asked.background === true
    if (inBackground && agent !== 'claude') return error(res, 400, 'バックグラウンドで始められるのは Claude だけです')
    if (handoff && (agent !== 'claude' || inBackground)) return error(res, 400, '引き継いで始められるのは Claude の（バックグラウンドでない）セッションだけです')

    const { sessions } = await store.sessions(days)
    const from = sessions.find((s) => s.id === asked.from)
    if (!from) return error(res, 404, 'session not found in window')
    let handoffTs = ''
    let handoffKey = ''
    // 始められなかったら印を外す（直してもう一度押せるように）
    const refuse = (status: number, message: string) => {
      if (handoffKey) handoffStarting.delete(handoffKey)
      return error(res, status, message)
    }
    if (handoff) {
      if (from.agent !== 'claude') return error(res, 400, '引き継げるのは Claude のセッションだけです')
      const rows = (await rowsNow(days)).filter((r) => entityId(r.session ?? '', r.repo ?? '', String(r.ts ?? '')) === from.id)
      const ready = handoffReady(rows)
      if (!ready) return error(res, 409, '引き継ぎがまだ書かれていません（最後のターンが引き継ぎの依頼への返答ではありません）')
      const old = await metaStore.get(from.id)
      // 同じ引き継ぎで 2 回始めない（2 枚の画面で押した・押し直した）
      // メタに書くのは起動のあとなので、その間に来た 2 本目はメモリの印で断る（#622 のレビュー。get のあと await を挟まずに置く）
      const key = `${from.id}\n${ready.ts}`
      if (old?.continued_at === ready.ts || handoffStarting.has(key)) return error(res, 409, 'この引き継ぎでは、もう新しいセッションを始めています')
      // 前のセッションがまだ回っていれば始めない（同じ worktree で 2 つが同時に動く）
      if (run.running(from.id) || typed.running(from.id)) return error(res, 409, '前のセッションがまだ処理中です。終わってから始めてください')
      handoffStarting.add(key)
      handoffKey = key
      text = handoffFirstText(ready.text)
      handoffTs = ready.ts
      // モデルと許可モードも引き継ぐ（保存済みの値なので検査は済んでいる。body で指定があればそちら）
      if (!meta.model && old?.model) meta.model = old.model
      if (!meta.permission_mode && old?.permission_mode) meta.permission_mode = old.permission_mode
    }
    // 別のマシンの worktree はこのマシンに無い（#114）
    if (isRemoteHost(from.host, selfHost())) return refuse(400, `別のマシン（${from.host}）の worktree なので、ここでは始められません`)
    // 始める場所を決める（#319）。**git の作業ツリーの中だけ**（`/`・`/tmp`・scratchpad は断る）。兄弟 worktree は
    // 鍵で選ばせ、`from` の cwd で `git worktree list` を読み直して、その中に同じ鍵があるときだけ通す（パスは受けない）
    const place = await startPlace(from, typeof asked.worktree === 'string' ? asked.worktree : '')
    if ('reason' in place) return refuse(400, place.reason)
    const { cwd } = place
    // エンティティ ID の repo は record.py が行に書くもの（cwd の toplevel の basename）に揃える。兄弟 worktree では from と違う
    const target: SessionSummary = { ...from, cwd, repo: place.repo }

    if (agent === 'codex') return await startCodexSession(res, target, cwd, text, meta)
    if (agent === 'opencode') return await startOpencodeSession(res, target, cwd, text, meta)
    if (inBackground) return await startBackgroundSession(res, target, cwd, text, meta)

    const session = randomUUID()
    const id = entityId(session, target.repo, '')
    // 「新しいセッションで送る」（#579）: 表示名・アイコン・一言の性格を引き継ぐ。前のセッションは触らない（消さない・アーカイブしない）
    if (asked.inherit === true || handoff) {
      const old = await metaStore.get(from.id)
      if (old?.name) meta.name = old.name
      if (old?.persona) meta.persona = old.persona
      const icon = await iconStore.get(from.id)
      if (icon) {
        const bytes = await readFile(icon.path).catch(() => null)
        if (bytes) await iconStore.put(id, bytes)
      }
    }
    if (handoff) meta.continued_from = from.id
    if (Object.keys(meta).length > 0) await metaStore.set(id, meta)
    const via = { url: selfUrl(req), entity: id, tokenFile: agentTokenPath }
    // 許可モードを選ばずに始めたら設定の既定で回す（#582）。**メタには書かない**（既定を変えたら次の返信から付いてくるように）
    const cmd = newSessionCommand(session, text, cwd, process.env, via, meta.model, await replyMode(meta) || undefined, meta.name)
    try {
      startedBin.set(id, cmd.bin)
      await run.start(id, cmd, () => {
        approvals.drop(id)
        void drain(id)
        // 終わったターンが誰かへの返答なら、送り元へ渡す（#594）
        void deliverReplies()
        void drainBacklog()
      })
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      const hint = code === 'ENOENT' ? `${cmd.bin} が見つかりません（サーバを起動した環境の PATH に ${cmd.bin} があるか確かめてください）` : ''
      return refuse(500, hint || (err instanceof Error ? err.message : String(err)))
    }
    // 前のセッションに「→ 続き」を書く（#442）。アーカイブはしない（人が決める）
    if (handoff) await metaStore.set(from.id, { ...((await metaStore.get(from.id)) ?? {}), continued_to: id, continued_at: handoffTs })
    // 人が始めたターン（メッセージの連鎖ではない。#311）
    agents.launched(id, undefined)
    const payload: NewSessionResponse = { accepted: true, id, agent: 'claude', session, cwd, via: 'process' }
    return json(res, payload, 202)
  }

  /**
   * `POST /api/sessions/new` の `claude --bg`（#462）。**ID はデーモンが決める**（`--session-id` は効かない）ので、
   * 返ってきた短い ID から `claude agents` で UUID を引いてからエンティティ ID を作る。
   * SAI の子プロセスではないので `run.start` には載せない（処理中は `claude agents` の `status` で見る）。
   * **許可・質問の配線は付けない**（`--permission-prompt-tool` が使われず、TUI のダイアログで止まる。実測）
   */
  const startBackgroundSession = async (
    res: ServerResponse,
    from: SessionSummary,
    cwd: string,
    text: string,
    meta: SessionMeta,
  ) => {
    const log = join(store.directory, 'reply.log')
    const cmd = backgroundSessionCommand(text, cwd, store.directory, process.env, meta.model, await replyMode(meta) || undefined, meta.name)
    await appendFile(log, `--- ${new Date().toISOString()} バックグラウンドで新しいセッション（claude --bg） (cwd ${cwd})\n`).catch(() => {})
    let started
    try {
      started = await background.start(cmd)
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      const hint = code === 'ENOENT' ? 'claude が見つかりません（サーバを起動した環境の PATH に claude があるか確かめてください）' : ''
      // 始まったが ID を引けなかったときは、そのまま（短い ID と「二重になる」を伝える文）
      const message = hint || (err instanceof BackgroundLookupError ? err.message : `バックグラウンドで始められませんでした: ${err instanceof Error ? err.message : String(err)}`)
      await appendFile(log, `${message}\n`).catch(() => {})
      return error(res, 500, message)
    }
    const id = entityId(started.sessionId, from.repo, '')
    if (Object.keys(meta).length > 0) await metaStore.set(id, meta)
    await appendFile(log, `${id} を始めた（claude attach ${started.short}）\n`).catch(() => {})
    // 人が始めたターン（メッセージの連鎖ではない。#311）
    agents.launched(id, undefined)
    const payload: NewSessionResponse = { accepted: true, id, agent: 'claude', session: started.sessionId, cwd, via: 'background', attach: started.short }
    return json(res, payload, 202)
  }

  /**
   * `POST /api/sessions/new` の Codex（#401）。`thread/start` で id を決めてから 1 ターン回す。
   * **`thread/start` だけでは rollout が書かれない**ので、起動に失敗すれば記録には何も残らない
   */
  const startCodexSession = async (
    res: ServerResponse,
    from: SessionSummary,
    cwd: string,
    text: string,
    meta: SessionMeta,
    /** スレッドの作り方。省略なら新しいスレッド（`thread/start`）。分岐（#405）は `thread/fork` を渡す */
    make: { thread: () => Promise<string>; label: string } = { thread: () => codexApp.startThread!(cwd), label: 'Codex の新しいセッション（thread/start → turn/start）' },
  ) => {
    const log = join(store.directory, 'reply.log')
    let session: string
    try {
      session = await make.thread()
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      const hint = code === 'ENOENT' ? 'codex が見つかりません（サーバを起動した環境の PATH に codex があるか確かめてください）' : ''
      return error(res, 500, hint || `Codex の新しいスレッドを作れませんでした: ${err instanceof Error ? err.message : String(err)}`)
    }
    // 記録の `session` は rollout から引かれるが、それは thread/start が返した id と同じになる（#401 で実測）
    const id = entityId(session, from.repo, '')
    if (Object.keys(meta).length > 0) await metaStore.set(id, meta)
    await appendFile(log, `--- ${new Date().toISOString()} ${id} ${make.label} (cwd ${cwd})\n`).catch(() => {})
    try {
      await codexApp.start({ id, threadId: session, text, cwd, model: meta.model })
    } catch (err) {
      const message = `Codex のセッションを始められませんでした: ${err instanceof Error ? err.message : String(err)}`
      await appendFile(log, `${message}\n`).catch(() => {})
      // 始まらなかったセッションのメタは残さない（行が無いので、画面からは消せない）
      if (Object.keys(meta).length > 0) await metaStore.set(id, {}).catch(() => {})
      return error(res, 500, message)
    }
    // 人が始めたターン（メッセージの連鎖ではない。#311）
    agents.launched(id, undefined)
    const payload: NewSessionResponse = { accepted: true, id, agent: 'codex', session, cwd, via: 'app-server' }
    return json(res, payload, 202)
  }

  /**
   * `POST /api/sessions/new` の OpenCode（#452）。`POST /session` で id を決めてから 1 ターン回す。
   * **作るのは長寿命の `opencode serve` の中**なので、許可を聞かれたらターンは待ち、画面から答えられる（#421）。
   * **セッションを作っただけでは記録に行が 1 本も書かれない**（プラグインは `session.idle` 起点）ので、
   * 1 ターン目を起こせなければ一覧には何も出ない（`replying` の `failed` だけが画面に出る）
   */
  const startOpencodeSession = async (
    res: ServerResponse,
    from: SessionSummary,
    cwd: string,
    text: string,
    meta: SessionMeta,
    /** セッションの作り方。省略なら新しいセッション（`POST /session`）。分岐（#398）は `POST /session/<id>/fork` を渡す */
    make: { session: () => Promise<string>; label: string; what: string } = {
      session: () => opencodeApp.startSession!(cwd),
      label: 'OpenCode の新しいセッション（POST /session → prompt_async）',
      what: 'OpenCode の新しいセッションを作れませんでした',
    },
  ) => {
    const log = join(store.directory, 'reply.log')
    let session: string
    try {
      session = await make.session()
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      const hint = code === 'ENOENT' ? 'opencode が見つかりません（サーバを起動した環境の PATH に opencode があるか確かめてください）' : ''
      return error(res, 500, hint || `${make.what}: ${err instanceof Error ? err.message : String(err)}`)
    }
    const id = entityId(session, from.repo, '')
    if (Object.keys(meta).length > 0) await metaStore.set(id, meta)
    await appendFile(log, `--- ${new Date().toISOString()} ${id} ${make.label} (cwd ${cwd})\n`).catch(() => {})
    try {
      await opencodeApp.start({ id, session, text, model: meta.model })
    } catch (err) {
      const message = `OpenCode のセッションを始められませんでした: ${err instanceof Error ? err.message : String(err)}`
      await appendFile(log, `${message}\n`).catch(() => {})
      // 始まらなかったセッションのメタは残さない（行が無いので、画面からは消せない。Codex の `startCodexSession()` と同じ。
      // 新しいセッションでも分岐でも）。**OpenCode の側に出来たセッションは消さない**（消す口を足していない。ターンが実は
      // 始まっていた場合に会話ごと消すことになる。分岐先は opencode の一覧に「(fork #N)」として残る）
      if (Object.keys(meta).length > 0) await metaStore.set(id, {}).catch(() => {})
      return error(res, 500, message)
    }
    // 人が始めたターン（メッセージの連鎖ではない。#311）
    agents.launched(id, undefined)
    const payload: NewSessionResponse = { accepted: true, id, agent: 'opencode', session, cwd, via: 'app-server' }
    return json(res, payload, 202)
  }

  const refuse =(status: number, message: string): Launched => ({ status, body: { error: message } })

  /**
   * 返信を 1 本起動する（本文と添付は検査済み）。`POST .../reply` と、預かった返信を回す `drain()` の両方が通る（#305）。
   * 応答は書かずに返す
   */
  /**
   * 生きている `claude --bg` のセッションを、いま止めてはいけない理由（#462）。止めてよければ空。
   * **attach している端末がある**か、**ターンが回っている**なら止めない（`launch()` のコメント）
   */
  const backgroundHold = async (bg: ClaudeAgent, session: SessionSummary): Promise<string> => {
    if (await background.attached(bg.id, bg.sessionId)) {
      return `端末で claude attach ${bg.id} して開いています。そちらで打ってください（SAI から送ると、止めるときにその端末を閉じてしまいます）`
    }
    // 2.1.276 の形（`status`）が来ていればそれで、2.1.278 は transcript で見る
    const legacy = bg.status === 'busy' || bg.status === 'waiting'
    if (legacy || (await progress.read(session)).active) {
      return bg.status === 'waiting'
        ? `バックグラウンドのセッションが許可・質問を待っています。端末で claude attach ${bg.id} して答えてください`
        : `バックグラウンドでターンが回っています。終わってから送ります（端末で見るなら claude attach ${bg.id}）`
    }
    return ''
  }

  const launch = async (id: string, text: string, attachments: string[], o: LaunchOptions): Promise<Launched> => {
    const { sessions } = await store.sessions(o.days)
    const session = sessions.find((s) => s.id === id)
    if (!session) return refuse(404, 'session not found in window')
    const blocked = replyBlockedReason(session, selfHost())
    if (blocked) return refuse(400, blocked)

    // CLI に渡す生のセッションIDは URL から切り出さず、行の session を使う（entity.ts に逆変換を足さない）
    const rows = (await rowsNow(o.days)).filter((r) => entityId(r.session ?? '', r.repo ?? '', String(r.ts ?? '')) === id)
    const raw = rows[rows.length - 1]?.session ?? ''
    if (!raw) return refuse(400, 'session id missing in rows')
    const cwd = session.cwd
    try {
      if (!cwd || !(await stat(cwd)).isDirectory()) throw new Error('not a directory')
    } catch {
      return refuse(400, `cwd が見つかりません: ${cwd || '(空)'}`)
    }
    const openTerminal = await terminalOf(session)
    // **走っているターンに足す**（#404）。画面が選んだときだけで、既定は今までどおり預かり。
    // 足せなければ（ターンが終わっていた・別のターンになった）そのまま下に落ちて預かるので、本文は落ちない
    if (o.steer && codexAppEnabled && codexApp.steer && canSteer(session.agent, codexApp.replying()[id])) {
      const log = join(store.directory, 'reply.log')
      await appendFile(log, `--- ${new Date().toISOString()} ${id} 走っているターンに足す（turn/steer）\n`).catch(() => {})
      if (await codexApp.steer(id, text, attachments)) {
        const payload: ReplyResponse = { accepted: true, id, agent: session.agent, session: raw, cwd, via: 'steer' }
        return { status: 202, body: payload }
      }
      await appendFile(log, '足せなかった（ターンが終わったか、別のターンになった）。今までどおりの経路へ\n').catch(() => {})
    }
    // Claude も同じ（#386）。SAI が起こした `claude -p` の入力の口（stream-json）に 2 通目の `user` を書く。
    // 実測（2.1.285）で、走っているツールが終わった直後に**同じターンの中で**取り込まれた。
    // 口が閉じていれば（result が出た・引き取った子）下に落ちて預かる
    if (o.steer && session.agent === 'claude' && run.steer && canSteer(session.agent, run.snapshot()[id])) {
      const log = join(store.directory, 'reply.log')
      if (run.steer(id, text)) {
        await appendFile(log, `--- ${new Date().toISOString()} ${id} 走っているターンに足す（stream-json の user）\n`).catch(() => {})
        const payload: ReplyResponse = { accepted: true, id, agent: session.agent, session: raw, cwd, via: 'steer' }
        return { status: 202, body: payload }
      }
      await appendFile(log, `--- ${new Date().toISOString()} ${id} 足せなかった（ターンが終わった）。今までどおりの経路へ\n`).catch(() => {})
    }
    // `claude --bg` で動いているセッション（#462）。**同じ ID を `-p --resume` すると CLI が断り、
    // `--bg --resume` は別のセッションに写してしまう**（実測）ので、止めてから `-p` で続けるしかない。
    //
    // **止めてよいのは「誰も開いていない」かつ「ターンが回っていない」ときだけ**（2026-09-24 に実測）:
    // - `claude stop` は **attach している端末をその場で閉じる**（`Session … has exited.`。打ちかけも消える）ので、
    //   `ps` で `claude attach <ID>` を探し、居れば止めない（`BackgroundSessions.attached()`。分からなければ居る扱い）
    // - 2.1.278 の `claude agents` はバックグラウンドの行に `state`（`working` / `stopped` / `done`）しか持たず、
    //   **いまターンが回っているかは分からない**。そこは transcript で見る（#302 の `progress.read().active`）。
    //   2.1.276 の `status`（`busy` / `waiting`）が来ていればそれも使う
    // どちらかに当たれば預かって待つ（人のターンを画面から殺さない。#384 と同じ線引き）。
    //
    // **一覧はまず覚えているものを見る**（返信のたびに `claude agents` を起こさない。実測 0.15〜0.20 秒で、
    // ここは端末に打ち込む経路より手前なので普通の返信まで遅くなる）。バックグラウンドの行があるときだけ、
    // 状態が古いと困るので引き直す
    const bgOf = async (): Promise<ClaudeAgent | null | undefined> => {
      if (session.agent !== 'claude' || !claudeAgents.background) return null
      const cached = await claudeAgents.background(raw)
      return cached ? await claudeAgents.background(raw, true) : cached
    }
    const bg = await bgOf()
    const bgLive = bg && backgroundLive(bg) ? bg : null
    // 止められない理由（無ければ止めてから `-p` で続ける）
    const bgHold = bgLive ? await backgroundHold(bgLive, session) : ''
    // 別プロセス（-p / app-server）のターンが動いているか、いま起動している最中か
    const busy = run.running(id) || codexApp.running(id) || opencodeApp.running(id) || launching.has(id) || bgHold !== ''
    // **要約してから送る**（#579）。本文を預かりの先頭に置いてから `/compact` のターンを起こす。要約のプロセスが終わると
    // `drain()` が本文を回し、要約が失敗すれば預かりは止まる（新しい順番の仕組みは作らない）。
    // 効くのは Claude で、端末で開いておらず（TUI に打ち込む経路では要約中の入力の扱いを確かめていない）、処理中でも
    // 預かりが残ってもいないときだけ。当たらなければ付いていないのと同じ（下の今までの経路）
    // 端末に打ち込んだ返信がまだ回っているのにペインが見つからないときも回さない（下の経路が 409 にするのと同じ。#590 のレビュー）
    if (o.compact && session.agent === 'claude' && !openTerminal && !busy && !typed.running(id) && !bgLive && queue.size(id) === 0) {
      const log = join(store.directory, 'reply.log')
      launching.add(id)
      try {
        const item = queue.add(id, text, attachments, o.url, new Date(), o.origin ?? '')
        if (!item) return refuse(409, `預かれるのは ${QUEUE_MAX} 件までです`)
        await appendFile(log, `--- ${new Date().toISOString()} ${id} 要約（/compact）してから送る。本文は預かりの先頭に置いた\n`).catch(() => {})
        const out = await startTurn(id, session, raw, cwd, null, compactPrompt(o.compactFrom ?? text), [], { ...o, forceProcess: true, compact: true })
        if (out.status !== 202) {
          // 要約を起こせなければ本文も預からない（画面が入力欄に戻す）
          queue.remove(id, item.queue_id)
          return out
        }
        agents.launched(id, o.origin)
        const payload: ReplyResponse = { accepted: true, id, agent: session.agent, session: raw, cwd, via: 'compact', queue_id: item.queue_id }
        return { status: 202, body: payload }
      } finally {
        launching.delete(id)
      }
    }
    if (o.compact) {
      await appendFile(join(store.directory, 'reply.log'), `--- ${new Date().toISOString()} ${id} 要約してから送るは当たらない（端末で開いている・処理中・預かりがある・Claude でない）。そのまま送る\n`).catch(() => {})
    }
    // 処理中なら預かる（#305）。処理中でなくても預かりが残っていれば後ろに並べる（先に預けたものを追い越さない）
    if (o.queue && (busy || queue.size(id) > 0)) {
      const item = queue.add(id, text, attachments, o.url, new Date(), o.origin ?? '')
      if (!item) return refuse(409, `預かれるのは ${QUEUE_MAX} 件までです。取り消すか、前の返信が終わるのを待ってください`)
      await appendFile(join(store.directory, 'reply.log'), `--- ${new Date().toISOString()} ${id} 処理中なので預かった（${queue.size(id)} 件目）\n`).catch(() => {})
      const payload: ReplyResponse = { accepted: true, id, agent: session.agent, session: raw, cwd, via: 'queued', queue_id: item.queue_id }
      return { status: 202, body: payload }
    }
    // 端末（tmux）で開いていれば、前のターンが動いていても打ち込んでよい。TUI が次のターンに回すので、
    // 端末で人が続けて打つのと同じになる。別プロセス（-p）の経路だけは二重起動になるので止める（#100, #170）
    if (bgHold) return { ...refuse(409, bgHold), retry: true }
    if (busy || (typed.running(id) && !openTerminal)) {
      return refuse(409, 'このセッションはまだ前の返信を処理中です')
    }
    if (bgLive) {
      const log = join(store.directory, 'reply.log')
      await appendFile(log, `--- ${new Date().toISOString()} ${id} 誰も開いていないバックグラウンドのセッションを止めてから続ける（claude stop ${bgLive.id}）\n`).catch(() => {})
      try {
        await background.stop(bgLive.id, cwd)
      } catch (err) {
        await appendFile(log, `止められなかった: ${err instanceof Error ? err.message : String(err)}\n`).catch(() => {})
        return refuse(409, `バックグラウンドのセッションを止められませんでした。端末で claude attach ${bgLive.id} して打ってください`)
      }
    }
    launching.add(id)
    try {
      // 送り元にまだ渡していない返答を、このターンの本文の頭に足す（#594）。起動できたときだけ「渡した」にする
      // 別のセッションから届いたメッセージで起こすターンには足さない（見出しが頭に無いと、送り元が返答を引き当てられない）。
      // `/` のスキル・コマンドと Codex の `$` も、頭に無いと CLI が展開しないので足さない（未渡しのまま次のターンへ）
      const handed = o.origin || /^[/$]/.test(text.trimStart()) ? { replies: [], ids: [] } : await pendingRepliesOf(id)
      const out = await startTurn(id, session, raw, cwd, openTerminal, withHandedReplies(text, handed.replies), attachments, o)
      if (out.status === 202 && handed.ids.length > 0) {
        agents.handed(handed.ids)
        rememberHanded(id, handed.ids, Date.now())
        await appendFile(join(store.directory, 'reply.log'), `--- ${new Date().toISOString()} ${id} 待っていなかった返答 ${handed.ids.length} 件を本文の頭に足した（${handed.ids.join(', ')}）\n`).catch(() => {})
      }
      // メッセージで起動したターンかを覚える（そのターンからは送らせない。連鎖 1 段。#311）。人の返信で起動したら忘れる
      if (out.status === 202) agents.launched(id, o.origin)
      return out
    } finally {
      launching.delete(id)
    }
  }

  /** launch() の続き。端末 → 開いている Codex の queue → app-server → 別プロセス、の順に経路を選んで起動する */
  const startTurn = async (
    id: string,
    session: SessionSummary,
    raw: string,
    cwd: string,
    openTerminal: Awaited<ReturnType<typeof terminalOf>>,
    text: string,
    attachments: string[],
    o: LaunchOptions,
  ): Promise<Launched> => {
    const { replaceTyped, forceProcess } = o
    // 新しい返信を送るので、前のターンのエラー（#475）は片付ける（どの経路で送っても）
    codexApp.clearFailure?.(id)

    // 端末（tmux）で開いていれば、そのペインに打ち込む。別プロセスを立てないので端末にも出て、トークンも少ない。
    // ペインが無い・別のプロセスなら -p にフォールバック。入力中・ダイアログ中なら 409（何も打ち込まない）
    const term = openTerminal
    // Codex は開いているスレッドを exec resume すると active writer と競合する。tmux に打てない場合は
    // app-server の queue へ渡す（別プロセスは短く起動するが、writer を奪わず開いている会話に届く）。
    // 「ほかが握っているか」はレビューと同じ `codexHeldElsewhere()`（SAI の app-server が読み込んでいるスレッドは除く）
    const codexActive = await codexHeldElsewhere(session, raw)
    // モデルは queue / exec resume の両方で使う。画像を `-i` で渡すのは exec resume だけ（queue は断る。#678）
    const own = await metaStore.get(id)
    const model = own?.model
    // 許可モードはメタにあればそれ、無ければ設定の既定（#582）
    const mode = await replyMode(own)
    const sendQueue = async () => {
      const cmd = codexQueueCommand(raw, text, cwd, process.env, model)
      await appendFile(join(store.directory, 'reply.log'), `--- ${new Date().toISOString()} ${id} 開いている Codex へ queue ${JSON.stringify(cmd.args)} (cwd ${cwd})\n`).catch(() => {})
      try {
        await queueCodex(cmd)
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code
        const hint = code === 'ENOENT' ? `${cmd.bin} が見つかりません（サーバを起動した環境の PATH に ${cmd.bin} があるか確かめてください）` : ''
        return refuse(500, hint || `Codex へキュー送信できませんでした: ${err instanceof Error ? err.message : String(err)}`)
      }
      // 受け取られたかは、2 分後に typed.checkDelivery() が確かめる（#329。受け取り手のいない queue でも exit 0 で返ってくる）
      typed.start(id, text, 'queue')
      const payload: ReplyResponse = { accepted: true, id, agent: session.agent, session: raw, cwd, via: 'queue', ...(attachments.length > 0 ? { note: QUEUE_IMAGE_NOTE } : {}) }
      return { status: 202, body: payload }
    }
    if (codexActive && (!term || forceProcess)) return sendQueue()
    if (term && forceProcess) {
      // 端末に打ちかけが消せない・ダイアログ中などで、画面が「端末を使わず送る」を選んだ
      await appendFile(join(store.directory, 'reply.log'), `--- ${new Date().toISOString()} ${id} 端末で開いているが別プロセスで回す（画面の指定 via: process）\n`).catch(() => {})
    }
    if (term && !forceProcess) {
      try {
        const { cleared } = await typeInto(terminal.tmux, terminal.ps, term, session.agent, text, { replaceTyped })
        if (cleared !== undefined) {
          // 消した打ちかけは戻せないので、手がかりとして reply.log に残す
          await appendFile(join(store.directory, 'reply.log'), `--- ${new Date().toISOString()} ${id} 端末の打ちかけを消して打ち込んだ: ${JSON.stringify(cleared)}\n`).catch(() => {})
        }
        typed.start(id, text)
        const payload: ReplyResponse = { accepted: true, id, agent: session.agent, session: raw, cwd, via: 'terminal' }
        return { status: 202, body: payload }
      } catch (err) {
        if (err instanceof TerminalBusy) {
          // 画面は code で出し分ける。typed のときだけ「消して送る」の確認を出せる
          // can_process: Claude は exec resume、active Codex は queue へ送り直せる。
          const payload: ReplyError = { error: `端末に打ち込めない: ${err.message}`, code: `terminal_${err.kind}`, can_process: true }
          if (err.kind === 'typed') payload.typed = err.typed
          return { status: 409, body: payload }
        }
        if (!(err instanceof TerminalGone) && (err as NodeJS.ErrnoException).code !== 'ENOENT') {
          return refuse(500, `端末に打ち込めなかった: ${err instanceof Error ? err.message : String(err)}`)
        }
        // ペインが消えた・tmux が無い → 別プロセスで回す
      }
    }
    // terminalOf() の後にペインが消えた場合も、開いている Codex は resume せず queue へ送る。
    if (codexActive) return sendQueue()
    // SAIから開始するCodex turnはapp-serverでresumeする。server requestとresponseを同じ接続で
    // 往復できるので、質問・承認をWeb UIで安全に答えられる。通常起動TUIは上の経路のまま。
    if (session.agent === 'codex' && codexAppEnabled) {
      // この経路も reply.log に残す（#329。残していなかったので、lock を残したターンがどの経路で回ったか追えなかった）
      const log = join(store.directory, 'reply.log')
      await appendFile(log, `--- ${new Date().toISOString()} ${id} Codex app-server で再開（thread/resume → turn/start） (cwd ${cwd})\n`).catch(() => {})
      try {
        await codexApp.start({ id, threadId: raw, text, cwd, model, attachments })
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code
        const hint = code === 'ENOENT' ? 'codex が見つかりません（サーバを起動した環境の PATH に codex があるか確かめてください）' : ''
        const message = hint || `Codex app-serverで再開できませんでした: ${err instanceof Error ? err.message : String(err)}`
        await appendFile(log, `${message}\n`).catch(() => {})
        return refuse(500, message)
      }
      const payload: ReplyResponse = { accepted: true, id, agent: session.agent, session: raw, cwd, via: 'app-server' }
      return { status: 202, body: payload }
    }
    // OpenCode は長寿命の `opencode serve` へ HTTP で送る（#382）。`opencode run -s` と違って、ワンショットの
    // プロセスを起こさないので **答えを返しても終わらない子**（#375）が出ず、許可も自動 reject されない（#273）。
    // セッションは ID だけで引け、**そのセッションの cwd で走る**ので、worktree ごとにサーバを起こさなくてよい
    if (session.agent === 'opencode' && opencodeServerEnabled) {
      const log = join(store.directory, 'reply.log')
      await appendFile(log, `--- ${new Date().toISOString()} ${id} opencode serve へ送る（prompt_async） (cwd ${cwd})\n`).catch(() => {})
      try {
        await opencodeApp.start({ id, session: raw, text, model, attachments })
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code
        const hint = code === 'ENOENT' ? 'opencode が見つかりません（サーバを起動した環境の PATH に opencode があるか確かめてください）' : ''
        const message = hint || `opencode serve に送れませんでした: ${err instanceof Error ? err.message : String(err)}`
        await appendFile(log, `${message}\n`).catch(() => {})
        return refuse(500, message)
      }
      const payload: ReplyResponse = { accepted: true, id, agent: session.agent, session: raw, cwd, via: 'app-server' }
      return { status: 202, body: payload }
    }
    // 許可・質問を画面で答える配線。MCP の子プロセスはこのサーバと同じマシンで動くので、宛先はブラウザが来た Host ではなく
    // このサーバ自身が待ち受けているアドレス（ループバック）。Host だと tailscale serve 経由（https://<host>.ts.net → 127.0.0.1:8787）で
    // 開いた画面からの返信が `http://<host>.ts.net`（80 番、誰も聞いていない）に投げて「SAI に届かない: fetch failed」になる
    // トークンの置き場も渡すと、MCP サーバが別のセッションに話しかけるツール（sai_*）を出す（#310）
    const via = { url: o.url, entity: id, tokenFile: agentTokenPath, ...(o.loop ? { loop: true } : {}) }
    // セッションに返信のモデルが設定されていれば（PUT /api/sessions/<id>/meta の model）それで回す
    // 表示名も渡すと、端末のタイトルと `/resume` のピッカーに SAI と同じ名前が出る（#391）
    const cmd = replyCommand(session.agent, raw, text, cwd, process.env, via, model, mode || undefined, attachments, own?.name)
    if (!cmd) return refuse(400, replyBlockedReason(session, selfHost()) || 'unsupported agent')
    if (o.compact) cmd.compact = true
    try {
      // プロセスが終わったら、そのセッションの答え待ちは deny で片付ける（もう誰も答えを取りに来ない）。
      // 預かっている返信があれば続けて回す（#305）
      startedBin.set(id, cmd.bin)
      await run.start(id, cmd, () => {
        approvals.drop(id)
        void drain(id)
        // 終わったターンが誰かへの返答なら、送り元へ渡す（#594）
        void deliverReplies()
        void drainBacklog()
      })
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      const hint = code === 'ENOENT' ? `${cmd.bin} が見つかりません（サーバを起動した環境の PATH に ${cmd.bin} があるか確かめてください）` : ''
      return refuse(500, hint || (err instanceof Error ? err.message : String(err)))
    }
    const payload: ReplyResponse = { accepted: true, id, agent: session.agent, session: raw, cwd, via: 'process' }
    return { status: 202, body: payload }
  }

  /**
   * 預かっている返信を 1 件回す（#305）。前のターンが終わっていて止めていなければ、先頭を起動して外す。
   * - **前の返信が失敗していたら回さずに止める**（`Replying.failed`。失敗したターンの続きを黙って積み上げない）。
   *   「続けて送る」（resume）を押したら、その失敗ではもう止めない
   * - 起動できなければ（端末に打てない・cwd が消えた・CLI が無い）外さずに止め、理由を画面に出す
   * - 呼ぶのは -p の exit、SAI 管理の Codex のターンの終わり、画面のポーリングのついで。
   *   再起動で引き取った子（exit を受け取れない）はポーリングで拾う
   */
  /** `claude --bg` のターンが終わるのを待っている預かり（#462）。次に見に行く時刻 */
  const bgRetryAt = new Map<string, number>()
  /**
   * 預かりを止める理由になる、前の返信の失敗。-p の失敗に加えて、SAI の app-server で回した Codex のターンが
   * エラーで終わったものも見る（#475 のレビュー。見ないと上限に当たったターンの直後に次の預かりを起動し、
   * 同じ上限でもう 1 本無駄にする）。止めるとき（drain）と「続けて送る」で覚えるときに同じものを見る
   */
  const failedReply = (id: string): Replying | undefined => [run.snapshot()[id], codexApp.replying()[id]].find((r) => r?.failed)
  const drain = async (id: string): Promise<void> => {
    const head = queue.peek(id)
    if (!head || queue.paused(id) || draining.has(id)) return
    // `claude --bg` のターンを待っている間は、ポーリングのたびに起動の経路（と `claude agents`）を回さない（#462）
    if ((bgRetryAt.get(id) ?? 0) > Date.now()) return
    if (run.running(id) || codexApp.running(id) || opencodeApp.running(id) || launching.has(id)) return
    draining.add(id)
    try {
      const last = failedReply(id)
      if (last?.failed && resumedFailure.get(id) !== last.since) {
        queue.pause(id, `前の返信が失敗したので止めています（${replyFailureText(last.failed)}）。続けるなら「続けて送る」`)
        return
      }
      const out = await launch(id, head.text, head.attachments, {
        days: QUEUE_DAYS,
        replaceTyped: false,
        forceProcess: false,
        url: head.url,
        queue: false,
        // 別のセッションから預かったメッセージなら、回したターンから先へ送らせない（#311）
        ...(head.origin ? { origin: head.origin } : {}),
      })
      if (out.status === 202) {
        queue.shift(id, head.queue_id)
        bgRetryAt.delete(id)
      }
      // `claude --bg` のターンが終わるのを待つ（#462）。止めずに、次のポーリングでもう一度
      else if (out.retry) bgRetryAt.set(id, Date.now() + (terminal.bgRetryMs ?? BG_RETRY_MS))
      else queue.pause(id, `預かった返信を送れませんでした: ${(out.body as ReplyError).error}`)
    } finally {
      draining.delete(id)
    }
  }

  /** 預かりのあるセッションを全部見る。画面のポーリングのついでに呼ぶ */
  const drainAll = async (): Promise<void> => {
    for (const id of queue.ids()) await drain(id)
    await deliverReplies()
    await drainBacklog()
    await tickLoops()
    // 待ち（#732）は `gh` を叩くので、ポーリングの応答を待たせない（タイマーが見に行く）。タイマーを立てない設定（テスト）のときだけここで待つ
    if (waitTickMs > 0) void tickWaits().catch(() => {})
    else await tickWaits()
  }

  /**
   * 返ってきた返答を、次のターンを待たずに送り元へ渡す（#594 の 2・3）。相手のターンが終わったときと、画面のポーリングのついでに呼ぶ。
   *
   * - **送り元がまだ回っていれば、その場で足す**（2）: 入力の口（#386 の stream-json）が開いている Claude のターンに、返答の塊を
   *   2 通目の `user` として書く。読み直しは増えない。足せたら「渡した」にする（次のターンには重ねない）
   * - **「返答が来たら起こす」で送ったもの**（3。`sai_send` の `wake`）: 同じターンで `wake` を付けたものが全部返った（か失敗した）ら、
   *   送り元のターンを **1 回だけ**起こす。人が「送信を止める」にしていれば起こさない・送り元の使用量の枠が残り少なければ起こさない・
   *   送り元が処理中なら預かりに並ぶ・起こしたターンからは送れない（連鎖 1 段。#311）。起こさなかった分は未渡しのまま残り、
   *   次に SAI から回るターンの頭に届く
   */
  let delivering = false
  const wakeSkipped = new Set<string>()
  const wakeGaveUp = new Set<string>()
  const deliverReplies = async (): Promise<void> => {
    if (delivering) return
    delivering = true
    try {
      const log = join(store.directory, 'reply.log')
      const notBefore = Date.now() - HANDED_KEEP_DAYS * 86_400_000
      const snap = run.snapshot()
      // 2: 回っている送り元に、その場で足す
      if (run.steer) {
        for (const [from, r] of Object.entries(snap)) {
          if (!r.interruptible || r.failed || r.compact) continue
          if (agents.unhanded(from, notBefore).length === 0) continue
          // sai_wait で待っている返答は、その応答で渡る（両方から渡すと同じターンで 2 回読ませる）
          const p = await pendingRepliesOf(from, (id) => Date.now() - (waitedAt.get(id) ?? 0) < AGENT_POLL_MS * 3)
          if (p.ids.length === 0) continue
          if (!run.steer(from, withHandedReplies(STEERED_NOTE, p.replies))) continue
          agents.handed(p.ids)
          // このターンが失敗したら「渡した」を取り消す（読まれていない）
          rememberHanded(from, p.ids, Date.parse(r.since) || Date.now())
          await appendFile(log, `--- ${new Date().toISOString()} ${from} 回っているターンに返答 ${p.ids.length} 件を足した（${p.ids.join(', ')}）\n`).catch(() => {})
        }
      }
      // 3: 「返答が来たら起こす」
      for (const group of agents.wakeGroups(notBefore)) {
        const first = group[0]!
        const from = first.from
        // 送ったターンがまだ回っていれば起こさない（上の 2 がその場で足す。足せなければ、ターンが終わってから）
        if (snap[from] && !snap[from]!.failed && snap[from]!.since === first.turn) continue
        // 同じ依頼の「起こす」がまだ預かりに残っていれば、送り切ってその返答がそろうまで起こさない（#727。先に起こすと 1 回で受け取れない）
        if (agents.heldBy(from).some((h) => h.wake && !h.halted && h.turn === first.turn)) continue
        const results = await Promise.all(group.map((m) => agentResult(m)))
        if (results.some((r) => !r || r.status === 'pending')) continue
        const key = group.map((m) => m.message_id).join(',')
        // 一度起こせなかった組は繰り返さない（ポーリングのたびに起動を試さない。返答は次のターンの頭で渡る）
        if (wakeGaveUp.has(key)) continue
        // 預かりに並んでいる「起こす」のその後を見る
        const parked = wakeQueued.get(key)
        if (parked) {
          const still = (queue.snapshot()[from]?.items ?? []).some((q) => q.queue_id === parked.queueId)
          if (still) continue
          wakeQueued.delete(key)
          if (agents.origin(from) === parked.origin) {
            // 預かりから回った（launch が origin を覚えている）
            agents.handed(parked.ids)
            rememberHanded(from, parked.ids, Date.now())
          } else {
            // 取り消された。渡していないまま残し、もう起こさない（次のターンの頭で渡る）
            wakeGaveUp.add(key)
          }
          continue
        }
        const skip = async (why: string) => {
          if (wakeSkipped.has(key)) return
          wakeSkipped.add(key)
          await appendFile(log, `--- ${new Date().toISOString()} ${from} 返答がそろったが起こさない（${why}）。次のターンの頭で渡す\n`).catch(() => {})
        }
        if (agents.isStopped(from)) {
          await skip('人が送信を止めている')
          continue
        }
        const { sessions } = await store.sessions(QUEUE_DAYS)
        const sender = sessions.find((s) => s.id === from)
        if (!sender) continue
        const over = usageRefusal(await usageStore.get(), sender.agent)
        if (over) {
          await skip(over)
          continue
        }
        // そろった分に加えて、ほかの未渡しの返答も一緒に渡す
        const p = await pendingRepliesOf(from)
        if (p.ids.length === 0) continue
        const out = await launch(from, withHandedReplies(WAKE_NOTE, p.replies), [], {
          days: QUEUE_DAYS,
          replaceTyped: false,
          forceProcess: false,
          url: first.url ?? '',
          queue: true,
          // メッセージで起こしたターンと同じ扱いにする（このターンからは送らせない。人が止めたら預かりからも取り消される）
          origin: first.message_id,
        })
        if (out.status !== 202) {
          wakeGaveUp.add(key)
          await skip(`起こせなかった: ${(out.body as ReplyError).error}`)
          continue
        }
        const started = out.body as ReplyResponse
        if (started.via === 'queued' && started.queue_id) {
          // 送り元が処理中で預かりに並んだ。**まだ渡していない**（人が取り消す・「送信を止める」で消えることがある）。回ったときに渡した扱いにする
          wakeQueued.set(key, { from, ids: p.ids, queueId: started.queue_id, origin: first.message_id })
        } else {
          agents.handed(p.ids)
          rememberHanded(from, p.ids, Date.now())
        }
        await appendFile(log, `--- ${new Date().toISOString()} ${from} 返答がそろったので起こした（${p.ids.join(', ')}。${started.via}）\n`).catch(() => {})
      }
    } finally {
      delivering = false
    }
  }

  // SAI 管理の Codex のターンが終わったら、預かりを回す（-p の exit と同じ扱い）
  codexApp.onTurnEnd?.((id) => {
    void drain(id)
    void deliverReplies()
    void drainBacklog()
  })

  /**
   * `DELETE /api/sessions/<id>/queue/<queue_id>`（預けた返信の取り消し）と `POST /api/sessions/<id>/queue/resume`
   * （止めた預かりの再開）。どちらも同一オリジンのみ（再開は CLI を起動する）
   */
  const queueAction = async (req: IncomingMessage, res: ServerResponse, id: string, rest: string) => {
    if (isCrossOrigin(req)) return error(res, 403, 'cross-origin request rejected')
    const method = req.method ?? 'GET'
    if (rest === QUEUE_RESUME) {
      if (method !== 'POST') return error(res, 405, 'method not allowed')
      // 止めた理由の失敗がまだ残っていても（2 分）、同じ失敗ではもう止めない
      // drain() と同じく、app-server のエラーで終わったターン（#475）も「覚えた失敗」にする
      const last = failedReply(id)
      if (last?.failed) resumedFailure.set(id, last.since)
      queue.resume(id)
      await drain(id)
    } else {
      if (method !== 'DELETE') return error(res, 405, 'method not allowed')
      // いま起動している先頭は取り消せない（取り消したつもりで回ってしまう）
      if (draining.has(id) && queue.peek(id)?.queue_id === rest) return error(res, 409, 'この返信はもう起動しています')
      if (!queue.remove(id, rest)) return error(res, 404, 'queued reply not found')
    }
    const payload: ReplyQueueResponse = { id, queue: queue.snapshot()[id] ?? { items: [] } }
    return json(res, payload)
  }

  /**
   * `POST /api/sessions/<id>/interrupt`（#384）。処理中のターンを止める。同一オリジンのみ（返信と同じ理由）。
   *
   * 止められるのは **SAI が回している Codex と OpenCode のターンだけ**: Codex は app-server の `turn/interrupt`
   * （自分が `thread/resume` したスレッドしか止められない）、OpenCode は SAI が起こした `opencode serve` の
   * `POST /session/<id>/abort`（#392）。どちらも端末で人が回しているターンには手が出ない。
   * `claude -p` には当たる口が無いので 400。
   *
   * **投げる前に預かりを止める**（#305 の「前の返信が失敗したら回さない」と同じ形）。止めると app-server から
   * `turn/completed` が届き、それが `onTurnEnd` → `drain()` に繋がっているので、止めた直後に次の預かりが走ってしまう。
   * 人が「続けて送る」を押したときだけ回す
   */
  const interrupt = async (req: IncomingMessage, res: ServerResponse, id: string) => {
    if (isCrossOrigin(req)) return error(res, 403, 'cross-origin request rejected')
    // どちらのターンが回っているかで止める口を選ぶ（同じセッションで両方が回ることは無い）
    // Claude の `-p` は入力の口が開いているときだけ（#386。`control_request` の `interrupt`）
    const claudeStop = run.interrupt && run.snapshot()[id]?.interruptible ? async (target: string) => run.interrupt?.(target) ?? false : undefined
    const stopper = codexApp.running(id) ? codexApp.interrupt?.bind(codexApp) : opencodeApp.running(id) ? opencodeApp.abort?.bind(opencodeApp) : claudeStop
    if (!stopper) {
      const busy = codexApp.running(id) || opencodeApp.running(id) || run.running(id) || typed.running(id)
      if (busy) return error(res, 400, '止められるのは SAI が起こしたターンだけです（端末に打ち込んだターン・立て直す前から回っているターンは止められません）')
      return error(res, 409, 'このセッションは処理中ではありません')
    }
    // 先に止める（await のあとに止めると、その間に届いた turn/completed が預かりを回しうる）
    const wasPaused = queue.paused(id)
    queue.pause(id, INTERRUPT_PAUSE)
    let stopped = false
    try {
      stopped = await stopper(id)
    } catch (err) {
      if (wasPaused) queue.pause(id, wasPaused)
      else queue.resume(id)
      return error(res, 502, err instanceof Error ? err.message : String(err))
    }
    if (!stopped) {
      if (wasPaused) queue.pause(id, wasPaused)
      else queue.resume(id)
      return error(res, 409, 'このターンはまだ止められません（起動した直後です）')
    }
    await appendFile(join(store.directory, 'reply.log'), `--- ${new Date().toISOString()} ${id} 人が処理中のターンを止めた（#384 / #392 / #386）\n`).catch(() => {})
    // 止めたターンは失敗にならないので、ループ（#634）が次の周を起こさないようにここで止めておく
    await pauseLoop(id, '人がターンを止めたので一時停止しました')
    const payload: ReplyQueueResponse = { id, queue: queue.snapshot()[id] ?? { items: [] } }
    return json(res, payload)
  }

  // ---- セッション同士のメッセージ（#310 / #311）

  /**
   * エージェント用の口（`/api/agent/*`）に通してよいか。通さないなら理由。
   * **ブラウザからは通さない**（`Origin` / `Sec-Fetch-Site` が付いていれば断る。画面の返信の口とは逆）うえで、
   * `agent-token` のファイルの中身を要る。ブラウザはこのファイルを読めないので、同一オリジンの画面も tailnet 経由も叩けない
   */
  const agentRefusal = (req: IncomingMessage): string => {
    if (req.headers.origin !== undefined || req.headers['sec-fetch-site'] !== undefined) return 'ブラウザからは使えません'
    if (!tokenMatches(agentToken, req.headers[AGENT_TOKEN_HEADER])) return 'トークンが合いません'
    return ''
  }

  /**
   * 送り元を確かめる。**SAI が起動して、いまそのターンを回しているセッションだけ**（最初の PR は Claude の `-p` の返信。
   * MCP サーバは SAI が `--mcp-config` で渡したときだけ動き、送り元はその `SAI_ENTITY`）。失敗して残っているだけのものは除く
   */
  const agentFrom = async (from: unknown): Promise<{ session: SessionSummary; sessions: SessionSummary[]; turn: string } | string> => {
    if (typeof from !== 'string' || !from) return 'from が無い'
    const turn = run.snapshot()[from]
    if (!turn || turn.failed || !run.running(from)) return '送り元のセッションは、SAI から起動したターンを回していません'
    const { sessions } = await sessionsWithMeta(QUEUE_DAYS)
    const session = sessions.find((s) => s.id === from)
    if (!session) return '送り元のセッションが見つかりません'
    return { session, sessions, turn: turn.since }
  }

  /**
   * worktree で変わっているファイル（#564 の `overlap`）。**ツールが呼ばれたときだけ**読み（ポーリングには乗せない）、
   * `(cwd, last_turn_ts)` で `CHANGED_PATHS_TTL_MS` だけ覚える。時間でも切るのは、呼んだ側はターンの途中で編集していて
   * `last_turn_ts` が変わらないため。cwd は行から取り、リクエストからは受けない
   */
  const changedCache = new Map<string, { at: number; paths: Promise<{ root: string; paths: string[] }> }>()
  const changedOf = (s: SessionSummary): Promise<{ root: string; paths: string[] }> => {
    if (!s.cwd || isRemoteHost(s.host, selfHost())) return Promise.resolve({ root: '', paths: [] })
    const key = `${s.cwd}\0${s.last_turn_ts ?? ''}`
    const hit = changedCache.get(key)
    if (hit && Date.now() - hit.at < CHANGED_PATHS_TTL_MS) return hit.paths
    const paths = changedPaths(git, s.cwd).catch(() => ({ root: '', paths: [] as string[] }))
    for (const [k, v] of changedCache) if (Date.now() - v.at >= CHANGED_PATHS_TTL_MS) changedCache.delete(k)
    changedCache.set(key, { at: Date.now(), paths })
    return paths
  }

  /**
   * セッションがいま何を持っているか（#727 の案 D の読む側）。`sai_sessions` の 2 つの口（SAI が渡す `sai` と tailnet の `/mcp`）が
   * 1 行に足す。**SAI は持ち場を書いて持たない**: ブランチ・open な PR・届いている依頼から機械で引けるものだけ。
   * - PR は記録で知っているリポジトリ（セッションの remote）だけを、`gh pr list` の決まった形で読む。**応答を待たせない**:
   *   前の結果があればそれを返し（古ければ裏で引き直す）、まだ 1 回も引いていないときだけ `HOLDING_PR_WAIT_MS` 待つ。
   *   引けなくても行は落とさない（PR の印が付かないだけ）
   * - 頼まれて未完の依頼は、`HOLDING_ASK_DAYS` 日以内に届けたメッセージのうち、返答（そのターンの完了の行）がまだ無いものと、
   *   まだ送っていない預かり。行は 1 回だけ舐める
   */
  const holdingsOf = async (list: readonly SessionSummary[], occupied: (s: SessionSummary) => boolean, sendable: (s: SessionSummary) => boolean = () => true, opts: { prs?: boolean } = {}): Promise<Map<string, SessionHolding>> => {
    // 同じリポジトリを書き方の違い（大文字小文字）で 2 回引かない（#533 と同じ。PR の画面が埋めたキャッシュとも揃う）
    const known = knownRepos(list)
    const repos = new Map<string, Promise<PrSummary[] | null | undefined>>()
    const prsOf = (asked: string): Promise<PrSummary[] | null | undefined> => {
      const repo = asked ? pickKnownRepo(known, asked) || asked : ''
      if (!repo || !prs.available || opts.prs === false) return Promise.resolve(null)
      const before = repos.get(repo)
      if (before) return before
      const hit = prs.cached?.(repo, HOLDING_PR_STALE_MS)
      let timer: NodeJS.Timeout | undefined
      const job =
        hit !== undefined
          ? Promise.resolve(hit)
          : Promise.race([
              prs.list(repo).catch(() => null),
              new Promise<null>((done) => {
                timer = setTimeout(() => done(null), HOLDING_PR_WAIT_MS)
                timer.unref()
              }),
            ]).finally(() => clearTimeout(timer))
      repos.set(repo, job)
      return job
    }
    // 返答の済んだメッセージの id（行を 1 回だけ舐める。見るのは依頼の新しさの分だけ）
    const notBefore = Date.now() - HOLDING_ASK_DAYS * 86_400_000
    const pending = new Map<string, AgentMessage[]>()
    for (const s of list) {
      const got = agents.sentTo(s.id, notBefore)
      if (got.length > 0) pending.set(s.id, got)
    }
    const replied = new Set<string>()
    if (pending.size > 0) {
      const matcher = deliveryMatcher()
      for (const row of await rowsNow(HOLDING_ASK_DAYS + 1)) {
        const id = deliveredId(matcher.headOf(row))
        if (id) replied.add(`${entityId(row.session ?? '', row.repo ?? '', String(row.ts ?? ''))}\0${id}`)
      }
    }
    // いま回っているターン（どの経路でも。読むだけで、片付けや配送の確かめは回さない）
    const turns: ReplyingMap = { ...typed.snapshot(), ...run.snapshot(), ...codexApp.replying(), ...opencodeApp.replying() }
    const out = new Map<string, SessionHolding>()
    await Promise.all(
      list.map(async (s) => {
        // 未完に数えるのは、返答がまだ無く、**まだ生きている**依頼だけ: 相手の預かりに並んでいるか、相手がいまターンを回している。
        // 失敗した・人が止めた・預かりから取り消された依頼（返答の行が来ない）を、いつまでも頼まれ中に数えない
        // 「回している」は、**その依頼で回っているターン**（いまのターンの入力が、その依頼の見出しを持つ）のときだけ。
        // 相手が別のターンを回しているだけでは、前に死んだ依頼を生き返らせない。端末に打ち込んだ依頼（`typed`）も同じ形で見る
        const inQueue = new Set(queue.origins(s.id))
        const turn = turns[s.id]
        const live = (m: AgentMessage) => inQueue.has(m.message_id) || (turn !== undefined && !turn.failed && isDeliveryOf(turn.text, m.message_id))
        const asks = [
          ...(pending.get(s.id) ?? []).filter((m) => !replied.has(`${s.id}\0${m.message_id}`) && live(m)).map((m) => m.text),
          ...agents.heldFor(s.id).map((h) => h.text),
        ]
        const repo = isRemoteHost(s.host, selfHost()) ? '' : githubRepoOf(s.remote)
        out.set(s.id, holdingOf({ branch: s.branch ?? '', prs: await prsOf(repo), asks, occupied: occupied(s) || launching.has(s.id), sendable: sendable(s) }))
      }),
    )
    return out
  }

  /**
   * GET /api/agent/sessions?from=。話しかけられる相手（同じ project の、返信できる別のセッション）。
   * 人が許した組の先の、**別のリポジトリのセッション**（#747）も後ろに並べる。そちらは呼び名・エージェント・空いているか、まで
   */
  const agentSessions = async (req: IncomingMessage, res: ServerResponse, q: URLSearchParams) => {
    const refusal = agentRefusal(req)
    if (refusal) return error(res, 403, refusal)
    const found = await agentFrom(q.get('from'))
    if (typeof found === 'string') return error(res, 409, found)
    const busy = (id: string) => run.running(id) || codexApp.running(id) || opencodeApp.running(id) || typed.running(id)
    const across = (await settingsStore.get()).send_across
    const everyone = agentTargets(found.sessions, found.session, selfHost(), across)
    // 細かく出すのは同じリポジトリの相手だけ（読み直す量・同じファイル・持っているもの）
    const targets = everyone.filter((s) => !isAcross(found.session, s, across))
    const others = everyone.filter((s) => isAcross(found.session, s, across))
    // 相手が読み直す量（直近の呼び出しの入力）。transcript の末尾を読むだけで、(mtime, size) が同じなら組み直さない（#311）
    const progressOf = await Promise.all(targets.map((s) => progress.read(s)))
    const sizes = progressOf.map((p) => p.context_tokens)
    // 同じファイルを触っているか（#564）。知らせるだけで、送るかはエージェントが決める
    const [mine, ...theirs] = await Promise.all([changedOf(found.session), ...targets.map(changedOf)])
    // いま何を持っているか（#727）。処理中（端末で人が回しているターンも。transcript の上で動いていれば）・待ち・預かりがあれば空きではない。
    // **ここでは端末と許可の走査を回さない**（画面の走査の結果を、同じリポジトリの相手だけの結果で上書きしないため）。
    // 待ちは行の `waiting` のまま見るので、端末で答えた直後は少しの間「空きではない」側に倒れる
    const active = new Map(targets.map((s, i) => [s.id, Boolean(progressOf[i]?.active)]))
    const queued = queue.snapshot()
    const holdings = await holdingsOf(targets, (s) => busy(s.id) || Boolean(active.get(s.id)) || Boolean(s.waiting) || (queued[s.id]?.items.length ?? 0) > 0)
    // 別のリポジトリの相手は、空いているかだけ（PR は引かない・走査も回さない）
    const otherActive = new Map(await Promise.all(others.map(async (s) => [s.id, (await progress.read(s)).active] as const)))
    const otherHoldings = await holdingsOf(others, (s) => busy(s.id) || Boolean(otherActive.get(s.id)) || Boolean(s.waiting) || (queued[s.id]?.items.length ?? 0) > 0, () => true, { prs: false })
    const payload: AgentSessionsResponse = {
      from: found.session.id,
      sessions: [...targets.map((s, i) => {
        const entry = agentEntry(s, busy(s.id), sizes[i] ?? 0, agentOverlap(mine ?? { root: '', paths: [] }, theirs[i] ?? { root: '', paths: [] }))
        const holding = holdings.get(s.id)
        return holding && Object.keys(holding).length > 0 ? { ...entry, holding } : entry
      }), ...others.map((s) => acrossEntry(s, busy(s.id), Boolean(otherHoldings.get(s.id)?.free)))],
    }
    return json(res, payload)
  }

  /**
   * メッセージを要約（`/compact`）してから始めさせるか（#624）。画面からの送信と同じ判定で、渡すのは**見出しを付ける前の文**
   * （着手の形かの判定も、`/compact` に添える指示もそこから作る）。相手が処理中・預かりがあるときは `launch()` が今までどおり
   * 預かりに並べる（画面からの送信と同じ。並んだものの前に要約は挟まない）
   */
  const messageCompactOf = (target: SessionSummary, text: string, contextTokens: number, asked: unknown): { compact?: true; compactFrom?: string } =>
    messageCompacts({ text, agent: target.agent, contextTokens, terminal: Boolean(target.terminal) }, CONTEXT_WARN_TOKENS, typeof asked === 'boolean' ? asked : undefined)
      ? { compact: true, compactFrom: text }
      : {}

  /**
   * POST /api/agent/send。別のセッションに送る（#310）。相手が処理中なら預かり（#305）に並ぶ。
   * 断るのは: トークン・送り元がターンを回していない・相手が同じ project の返信できるセッションでない（403）、
   * 受け取ったメッセージで回っているターンから（連鎖）・1 ターンの回数を超えた（429。#311）
   */
  const agentSend = async (req: IncomingMessage, res: ServerResponse) => {
    const refusal = agentRefusal(req)
    if (refusal) return error(res, 403, refusal)
    let body: unknown
    try {
      body = await readJson(req, MAX_REPLY_BYTES)
    } catch (err) {
      return error(res, 400, err instanceof Error ? err.message : 'bad body')
    }
    const b = (body ?? {}) as Partial<AgentSendRequest>
    // **同じ送り元からの送信は 1 つずつ通す**（#727 のレビュー）。エージェントがツールを並べて呼ぶと、どの呼び出しも
    // 「まだ 0 回」を見てしまい、回数の上限も依頼の上限も数え損ねる（預かりの順も崩れる）
    const key = typeof b.from === 'string' ? b.from : ''
    const before = sendLocks.get(key) ?? Promise.resolve()
    let release: () => void = () => {}
    const mine = before.then(() => new Promise<void>((done) => (release = done)))
    sendLocks.set(key, mine)
    await before
    try {
      return await agentSendOne(req, res, b)
    } finally {
      release()
      if (sendLocks.get(key) === mine) sendLocks.delete(key)
    }
  }
  const sendLocks = new Map<string, Promise<void>>()
  const agentSendOne = async (req: IncomingMessage, res: ServerResponse, b: Partial<AgentSendRequest>) => {
    // 宛先は 1 つ（`to` / `text`）か、1 つの依頼としての複数（`items`。#727）。どちらも同じ道を通す。
    // 空の `items` は付いていないのと同じ（省略できる配列を空で埋めて呼ぶモデルがある）
    const many = b.items !== undefined && !(Array.isArray(b.items) && b.items.length === 0)
    if (many && (!Array.isArray(b.items) || b.items.some((it) => !it || typeof it !== 'object'))) return error(res, 400, 'items は { to, text } の配列で送ってください')
    const asks = many ? b.items!.map((it) => ({ to: it.to, text: it.text, compact: it.compact })) : [{ to: b.to, text: b.text, compact: b.compact }]
    if (asks.length > AGENT_REQUEST_MAX) return error(res, 429, requestRefusal(0, 0, asks.map(() => ({ name: '', tokens: 0 }))))
    const nth = (n: number) => (many ? `${n + 1} 件目: ` : '')
    for (const [n, a] of asks.entries()) {
      const text = typeof a.text === 'string' ? a.text.trim() : ''
      if (!text) return error(res, 400, `${nth(n)}text が要ります`)
      if (text.length > AGENT_TEXT_MAX_CHARS) return error(res, 400, `${nth(n)}送れるのは ${AGENT_TEXT_MAX_CHARS} 字までです。短くまとめてください`)
    }
    const found = await agentFrom(b.from)
    if (typeof found === 'string') return error(res, 409, found)
    const from = found.session.id
    // 待ちで SAI が起こしたターン（#732）からは送らせない（人が見ていない間に、起きたターンが次のターンを起こさない）
    if (isWaitPrompt(splitHandedReplies(run.snapshot()[from]?.text ?? '').text)) return error(res, 429, '待ちで起きたターンからは、別のセッションへ送れません（結果を報告して終えてください）')
    // 人が止めている・受け取ったメッセージで回っているターン（連鎖）からは、預かりもしない（回数はここでは見ない）
    const barred = agents.refusal(from, found.turn, Infinity)
    if (barred) return error(res, 429, barred)
    // 宛先は id か呼び名（#625）。引くのは送ってよい相手の中からだけで、ちょうど 1 つに決まらなければ送らない
    // 送ってよい相手: 同じ project と、人が許した組の先の project（#747）。歯止めは下の同じ判定を通す
    const across = (await settingsStore.get()).send_across
    const targets = agentTargets(found.sessions, found.session, selfHost(), across)
    // 同じ project（と、許した組の先の project）に居るが送れないセッション（別のマシンなど）。同じ名前がそこにも居れば、名前では当てない
    const blocked = found.sessions.filter((s) => s.id !== from && (s.project === found.session.project || isAcross(found.session, s, across)) && !s.archived && !targets.includes(s))
    // **先に全部の宛先を確かめて数える**（#727）。1 つでも通らなければ、1 件も送らず・預からずに断る
    const usageNow = await usageStore.get()
    const planned: { target: SessionSummary; far: boolean; text: string; context: number; compact: boolean | undefined }[] = []
    for (const [n, a] of asks.entries()) {
      const asked = typeof a.to === 'string' ? a.to : ''
      // 別のリポジトリの相手は、id か人が付けた表示名でだけ引く（worktree 名・題名では当てない。#747）
      let resolved = resolveTarget(targets, asked, blocked, (s) => (isAcross(found.session, s, across) ? acrossNames(s) : targetNames(s)))
      // 名前で引いて別のリポジトリの相手に決まったとき、**送り元のリポジトリに同じ名前のセッションが居れば送らない**
      // （アーカイブ済みでも。人が指していたのがそちらかもしれないのに、別のリポジトリへ黙って届かせない）
      if (resolved.target && resolved.target.id !== asked && isAcross(found.session, resolved.target, across)) {
        const key = asked.trim().toLowerCase()
        const local = found.sessions.filter((s) => s.id !== from && s.project === found.session.project && targetNames(s).includes(key)).length
        if (local > 0) resolved = { target: null, ambiguous: true, candidates: [resolved.target], hidden: local }
      }
      if (!resolved.target) {
        return error(res, resolved.ambiguous ? 409 : 403, nth(n) + targetRefusal(asked, resolved, 'その相手には送れません（同じリポジトリか、人が許したリポジトリの、SAI から返信できる別のセッションだけ。sai_sessions で確かめてください）', found.session.project))
      }
      // 使用量の枠が残り少なければ送らない。見るのは相手のエージェントの枠（受け取って読み直すのは相手。#311）
      const overUsage = usageRefusal(usageNow, resolved.target.agent)
      if (overUsage) return error(res, 429, nth(n) + overUsage)
      // 相手の大きさは transcript / rollout の直近の呼び出しの入力
      const context = (await progress.read(resolved.target)).context_tokens
      // 1 件だけで 1 ターンの読み直しの予算を超える相手には、預かっても送れない（1 巡の予算は同じ）。今までどおり断る（#311）
      const far = isAcross(found.session, resolved.target, across)
      const tooBig = budgetRefusal(0, context)
      // 別のリポジトリの相手の量は、断りの文にも出さない（一覧で伏せている。#747）
      if (tooBig) return error(res, 429, nth(n) + (far ? 'この相手は、1 件で 1 ターンの読み直しの予算を超えます（別のリポジトリの相手の量は出しません）。人に確かめてください' : tooBig))
      planned.push({ far, target: resolved.target, text: (a.text as string).trim(), context, compact: typeof a.compact === 'boolean' ? a.compact : undefined })
    }
    const heldBefore = agents.heldInTurn(from, found.turn)
    const sentBefore = agents.sentInTurn(from, found.turn)
    // この依頼がその場で送り切れるか（1 ターンの回数と読み直しの予算。#311）。送り切れないなら、依頼の上限（#727）を先に見る
    let spent = agents.readInTurn(from, found.turn)
    // 預かりが残っている間は、あとから来た送信も後ろに並べる（前のターンで預かった分を追い越さない）
    let room = agents.heldBy(from).some((h) => !h.halted) ? 0 : Math.max(0, AGENT_SEND_MAX - sentBefore)
    let direct = 0
    for (const p of planned) {
      if (room <= 0 || budgetRefusal(spent, p.context)) break
      room--
      spent += p.context
      direct++
    }
    if (direct < planned.length) {
      const over = requestRefusal(sentBefore + heldBefore.count, agents.readInTurn(from, found.turn) + heldBefore.read, planned.map((p) => ({ name: sessionLabel(p.target), tokens: p.context, ...(p.far ? { hidden: true } : {}) })), agents.hiddenInTurn(from, found.turn) + heldBefore.hidden > 0)
      if (over) return error(res, 429, over)
    }
    const results: AgentSendResult[] = []
    for (const [n, p] of planned.entries()) {
      const to = p.target.id
      const messageId = agents.newId()
      // 別のリポジトリの相手（#747）は、呼び名を題名に落とさず、読み直す量も返さない（予算には数えている）
      const base = { message_id: messageId, to, to_name: p.far ? acrossLabel(p.target) : sessionLabel(p.target), context_tokens: p.far ? 0 : p.context }
      if (n >= direct) {
        // 預かる（#727）。送るのは送り元のターンが終わってから（`drainBacklog()`）
        agents.hold({ message_id: messageId, from, to, text: p.text, turn: found.turn, at: new Date().toISOString(), context: p.context, url: selfUrl(req), ...(p.far ? { far: true as const } : {}), ...(b.wake === true ? { wake: true as const } : {}), ...(p.compact !== undefined ? { compact: p.compact } : {}) })
        await appendFile(join(store.directory, 'reply.log'), `--- ${new Date().toISOString()} ${from} → ${to} メッセージ ${messageId} を預かった（1 ターンの上限を超えた分。ターンが終わってから送る）\n`).catch(() => {})
        results.push({ ...base, held: true })
        continue
      }
      const delivered = deliveredText({ label: sessionLabel(found.session), project: found.session.project }, messageId, p.text)
      const compact = messageCompactOf(p.target, p.text, p.context, p.compact)
      const out = await launch(to, delivered, [], { days: QUEUE_DAYS, replaceTyped: false, forceProcess: false, url: selfUrl(req), queue: true, origin: messageId, ...compact })
      if (out.status !== 202) {
        // 別のリポジトリの相手（#747）の起動の失敗は、理由を返さない（相手の作業ディレクトリのパスなどが文に入る）。理由は reply.log に残る
        const why = p.far ? '相手のセッションを始められませんでした（別のリポジトリの相手の理由は出しません。人に確かめてください）' : (out.body as ReplyError).error
        if (p.far) await appendFile(join(store.directory, 'reply.log'), `--- ${new Date().toISOString()} ${from} → ${to} 別のリポジトリへのメッセージを送れなかった: ${(out.body as ReplyError).error}\n`).catch(() => {})
        if (!many) return p.far ? error(res, out.status, why) : json(res, out.body, out.status)
        results.push({ ...base, error: why })
        continue
      }
      const via = (out.body as ReplyResponse).via
      agents.record(
        { message_id: messageId, from, to, text: p.text, since: new Date().toISOString(), turn: found.turn, ...(p.far ? { far: true as const } : {}), ...(b.wake === true ? { wake: true as const, url: selfUrl(req) } : {}) },
        found.turn,
        p.context,
      )
      await appendFile(join(store.directory, 'reply.log'), `--- ${new Date().toISOString()} ${from} → ${to} メッセージ ${messageId}（${via}）\n`).catch(() => {})
      results.push({ ...base, via })
    }
    const counts = {
      sent: agents.sentInTurn(from, found.turn),
      limit: AGENT_SEND_MAX,
      // 別のリポジトリの相手の分（#747）は、合計からも引いて返す（引き算で相手の量が分からないように。予算には数えている）
      read_tokens: agents.readInTurn(from, found.turn) - agents.hiddenInTurn(from, found.turn),
      read_budget: AGENT_TURN_READ_BUDGET,
    }
    const heldCount = agents.heldBy(from).length
    if (many) {
      const payload: AgentSendManyResponse = { results, ...counts, held_count: heldCount }
      return json(res, payload, 202)
    }
    const one = results[0]!
    const payload: AgentSendResponse = {
      message_id: one.message_id,
      to: one.to,
      to_name: one.to_name,
      ...(one.via ? { via: one.via } : {}),
      ...(one.held ? { held: true as const, held_count: heldCount } : {}),
      ...counts,
      context_tokens: one.context_tokens,
    }
    return json(res, payload, 202)
  }

  /**
   * 預かった送信（#727）を送る。**送り元のターンが終わってから**（回っている間は送らない）、1 巡に `AGENT_SEND_MAX` 件・
   * `AGENT_TURN_READ_BUDGET` まで、巡と巡の間は `AGENT_BACKLOG_ROUND_MS` 空ける。相手のターンが終わったとき・画面のポーリングの
   * ついで・前の巡のタイマーから呼ぶ。
   *
   * - 人が「送信を止める」にしていれば送らない（押したときに預かりごと捨てている）
   * - 送る直前にもう一度確かめる: 相手がまだ送ってよい相手か・相手の使用量の枠。通らなければその 1 件は捨てて `reply.log` に残す
   * - **送る前に送りかけの印を書く**（`beginHeld()`）。印が付いたまま立て直されたら送り直さない
   * - 送り方は `sai_send` と同じ `launch()`（相手が処理中なら相手の預かりに並ぶ。権限のフラグは足さない）
   */
  const backlogRoundAt = new Map<string, number>()
  const backlogTimers = new Map<string, NodeJS.Timeout>()
  let backlogBusy = false
  /** 巡の途中で呼ばれた（別の送り元のターンが終わった、など）。終わったらもう 1 回見る */
  let backlogAgain = false
  const drainBacklog = async (): Promise<void> => {
    if (backlogBusy) {
      backlogAgain = true
      return
    }
    backlogBusy = true
    const log = join(store.directory, 'reply.log')
    try {
      do {
        backlogAgain = false
        const froms = agents.heldFroms().filter((from) => !agents.isStopped(from) && agents.heldBy(from).some((h) => !h.halted))
        if (froms.length === 0) break
        // 一覧と使用量は 1 巡に 1 回だけ取る
        const { sessions } = await sessionsWithMeta(QUEUE_DAYS)
        const usageNow = await usageStore.get()
        for (const from of froms) {
          // 送り元がまだ回っている間は送らない（ターンの終わりがもう一度ここを呼ぶ）
          if (run.running(from)) continue
          const wait = (backlogRoundAt.get(from) ?? 0) + AGENT_BACKLOG_ROUND_MS - Date.now()
          if (wait > 0) {
            scheduleBacklog(from, wait)
            continue
          }
          const sender = sessions.find((x) => x.id === from)
          if (!sender) {
            // 一覧の窓の外に出た送り元。見出しを組めないので送らない（忘れずに残し、時間を置いてもう一度見る）
            scheduleBacklog(from, AGENT_BACKLOG_ROUND_MS)
            continue
          }
          // 預かったあとに人が組を外していれば、その先へはもう送らない（#747）
          const targets = agentTargets(sessions, sender, selfHost(), (await settingsStore.get()).send_across)
          let sentNow = 0
          let readNow = 0
          for (const h of agents.heldBy(from)) {
            if (h.halted) continue
            if (sentNow >= AGENT_SEND_MAX) break
            // 巡の途中で人が「送信を止める」を押した
            if (agents.isStopped(from)) break
            // 送らないと決めた 1 件は捨てずに止めて残す（エージェントには「預かった」と返してあるので、黙って消さない。画面に理由が出る）
            const halt = async (why: string) => {
              agents.haltHeld(h.message_id, why)
              await appendFile(log, `--- ${new Date().toISOString()} ${from} → ${h.to} 預かっていたメッセージ ${h.message_id} は送らなかった: ${why}\n`).catch(() => {})
            }
            try {
              const target = targets.find((x) => x.id === h.to)
              const gone = !target ? '相手がもう送れるセッションではありません' : usageRefusal(usageNow, target.agent)
              if (!target || gone) {
                await halt(gone)
                continue
              }
              const context = (await progress.read(target)).context_tokens
              // 預かったあとに相手が大きくなって、1 件で 1 巡の予算を超えた
              const tooBig = budgetRefusal(0, context)
              if (tooBig) {
                await halt(tooBig)
                continue
              }
              // この巡の予算の残りに入らなければ、次の巡へ
              if (budgetRefusal(readNow, context)) break
              if (!agents.beginHeld(h.message_id)) continue
              const delivered = deliveredText({ label: sessionLabel(sender), project: sender.project }, h.message_id, h.text)
              const compact = messageCompactOf(target, h.text, context, h.compact)
              const out = await launch(h.to, delivered, [], { days: QUEUE_DAYS, replaceTyped: false, forceProcess: false, url: h.url, queue: true, origin: h.message_id, ...compact })
              if (out.status !== 202) {
                await halt(`送れませんでした: ${(out.body as ReplyError).error}`)
                continue
              }
              // 起動を待っている間に人が「送信を止める」を押した（預かりはもう捨てられている）。相手の預かりに並んだだけなら
              // 取り消す（止めた側の取り消しは記録から探すので、まだ記録していないこの 1 件には当たらない）。
              // もう相手で回り始めていたら止めない（相手で回っているターンは止めない）ので、届いたものとして記録する
              if (!agents.heldBy(from).some((x) => x.message_id === h.message_id)) {
                const removed = queue.removeWhere((_to, item) => item.origin === h.message_id)
                if (removed > 0) {
                  await appendFile(log, `--- ${new Date().toISOString()} ${from} → ${h.to} 預かっていたメッセージ ${h.message_id} は、止められたので取り消した\n`).catch(() => {})
                  continue
                }
              }
              // 記録してから預かりを外す（どちらも同じファイル。記録の済んだ預かりは、読み込むときにも捨てる）。
              // 1 ターンの回数・量（`sends`）には足さない（送り元がいま回している別のターンの数を潰さない）
              agents.recordHeld({ message_id: h.message_id, from, to: h.to, text: h.text, since: new Date().toISOString(), turn: h.turn, ...(h.far ? { far: true as const } : {}), ...(h.wake ? { wake: true as const, url: h.url } : {}) })
              agents.dropHeld(h.message_id)
              sentNow++
              readNow += context
              await appendFile(log, `--- ${new Date().toISOString()} ${from} → ${h.to} 預かっていたメッセージ ${h.message_id} を送った（${(out.body as ReplyResponse).via}）\n`).catch(() => {})
            } catch (err) {
              // 途中で落ちた 1 件は、送りかけの印が付いたままになる。届いたか分からないので送り直さず、止めて残す
              await halt(`送っている途中で失敗しました: ${err instanceof Error ? err.message : String(err)}`)
            }
          }
          if (sentNow > 0) backlogRoundAt.set(from, Date.now())
          if (agents.heldBy(from).some((h) => !h.halted)) scheduleBacklog(from, AGENT_BACKLOG_ROUND_MS)
        }
      } while (backlogAgain)
    } catch (err) {
      // 一覧・使用量が読めなかった巡は何もしない（預かりは残る）。タイマーはもう切れているので、掛け直してもう一度見る
      for (const from of agents.heldFroms()) scheduleBacklog(from, AGENT_BACKLOG_ROUND_MS)
      await appendFile(log, `--- ${new Date().toISOString()} 預かったメッセージを送る巡が失敗した: ${err instanceof Error ? err.message : String(err)}\n`).catch(() => {})
    } finally {
      backlogBusy = false
    }
  }
  /** 次の巡を時間で起こす（画面を開いていなくても進むように）。プロセスの終了は待たせない */
  const scheduleBacklog = (from: string, ms: number): void => {
    if (backlogTimers.has(from)) return
    const timer = setTimeout(() => {
      backlogTimers.delete(from)
      void drainBacklog()
    }, Math.max(0, ms))
    timer.unref()
    backlogTimers.set(from, timer)
  }
  // 前のサーバが残した預かりを、画面が開かれなくても送り始める（立て直したあとに忘れない）
  for (const from of agents.heldFroms()) scheduleBacklog(from, BACKLOG_STARTUP_MS)

  /**
   * 送り元（`from`）にまだ渡していない返答（#594）。送ってから `HANDED_KEEP_DAYS` 以内で、相手のターンが終わった・失敗したものだけ（古い順）。
   * まだ返っていない依頼は足さない
   */
  const AGENT_FAR_FAILED = '相手のセッションで失敗しました（別のリポジトリの相手の理由は出しません。人に確かめてください）'
  const pendingRepliesOf = async (from: string, skip?: (messageId: string) => boolean): Promise<{ replies: PendingReply[]; ids: string[] }> => {
    const waiting = agents.unhanded(from, Date.now() - HANDED_KEEP_DAYS * 86_400_000).filter((m) => !skip?.(m.message_id))
    if (waiting.length === 0) return { replies: [], ids: [] }
    // 相手の呼び名。**別のリポジトリの相手は、人が付けた表示名か `#<worktree 名>` だけ**（#747。題名＝相手のリポジトリの人の入力を、
    // 返答の見出しから送り元の文脈へ流さない）。表示名はメタを重ねた一覧から引く（同じリポジトリの相手は今までどおり）
    // 別のリポジトリだったかは送ったときの印（`far`）で見る（いまの行や組から決め直さない）
    const { sessions } = await store.sessions(QUEUE_DAYS)
    const named = waiting.some((m) => m.far) ? (await sessionsWithMeta(QUEUE_DAYS).catch(() => ({ sessions: [] as SessionSummary[] }))).sessions : []
    const nameOf = (m: AgentMessage) => {
      const target = sessions.find((s) => s.id === m.to)
      if (!target) return m.to
      return m.far ? acrossLabel(named.find((s) => s.id === m.to) ?? { ...target, meta: undefined }) : replierName(target)
    }
    const replies: PendingReply[] = []
    for (const m of waiting) {
      const r = await agentResult(m)
      if (!r || r.status === 'pending') continue
      replies.push({ message_id: m.message_id, to_name: nameOf(m), status: r.status, ...(r.text !== undefined ? { text: r.text } : {}), ...(r.error !== undefined ? { error: r.error } : {}) })
    }
    return { replies, ids: replies.map((r) => r.message_id) }
  }

  /**
   * 送ったメッセージの結果。相手のそのターンが終わっていれば返答、失敗・止まっていれば理由。まだなら null。
   * 別のリポジトリの相手（`far`。#747）の失敗の理由は出さない（reply.log の末尾＝相手の CLI の出力や、相手の cwd が入る）
   */
  const agentResult = async (message: AgentMessage): Promise<AgentWaitResponse | null> => {
    const base = { message_id: message.message_id, to: message.to }
    const answered = replyOf(await rowsNow(QUEUE_DAYS), message.to, message.message_id)
    if (answered) return { ...base, status: 'done', text: clipReply(answered.text ?? '') }
    const turn = run.snapshot()[message.to]
    if (turn?.failed && isDeliveryOf(turn.text, message.message_id)) {
      return { ...base, status: 'failed', error: message.far ? AGENT_FAR_FAILED : replyFailureText(turn.failed) }
    }
    // 預かりの先頭のまま止まった（前の返信が失敗した・起動できなかった）
    const paused = queue.paused(message.to)
    if (paused && isDeliveryOf(queue.peek(message.to)?.text, message.message_id)) return { ...base, status: 'failed', error: message.far ? AGENT_FAR_FAILED : paused }
    return null
  }

  /**
   * GET /api/agent/wait?from=&message_id=&wait=1。**送った本人だけ**が待てる。wait なら最大 WAIT_MS までサーバ側で待ち、
   * まだなら 202（MCP サーバが繰り返す。エージェントに何度もツールを呼ばせない。#311）
   */
  const agentWait = async (req: IncomingMessage, res: ServerResponse, q: URLSearchParams) => {
    const refusal = agentRefusal(req)
    if (refusal) return error(res, 403, refusal)
    const message = agents.get(q.get('message_id') ?? '')
    if (!message || message.from !== q.get('from')) return error(res, 404, 'そのメッセージは見つかりません（送った本人だけが待てます。SAI を立て直すと見失います）')
    const until = Date.now() + (q.get('wait') === '1' ? WAIT_MS : 0)
    for (;;) {
      // いま sai_wait で待っている（返答はこの応答で渡るので、入力の口からは足さない。#607 のレビュー）
      waitedAt.set(message.message_id, Date.now())
      const result = await agentResult(message)
      // sai_wait で受け取ったものは送り元の会話に入った（#594）。次のターンの頭に重ねて足さない
      if (result) {
        agents.handed([message.message_id])
        return json(res, result)
      }
      if (Date.now() >= until) return json(res, { message_id: message.message_id, to: message.to, status: 'pending' } satisfies AgentWaitResponse, 202)
      await new Promise((r) => setTimeout(r, AGENT_POLL_MS))
    }
  }

  /**
   * そのセッション（送り元）から別のセッションへのメッセージのようす（#311）。送ったことが無く止めてもいなければ undefined。
   * 往復数と読み直させた量は**いま回しているターン**のもの（回していなければ 0）。直近の送り先は状態も付ける
   */
  const agentActivityOf = async (id: string, sessions: SessionSummary[]): Promise<AgentActivity | undefined> => {
    if (!agents.hasActivity(id)) return undefined
    const current = run.snapshot()[id]
    const turn = current && !current.failed && run.running(id) ? current.since : ''
    const recent = await Promise.all(
      agents.sentBy(id).map(async (m): Promise<AgentActivityMessage> => {
        const result = await agentResult(m)
        const target = sessions.find((s) => s.id === m.to)
        return { message_id: m.message_id, to: m.to, to_name: target ? sessionLabel(target) : m.to, since: m.since, status: result ? result.status : 'pending' }
      }),
    )
    const held: AgentHeldMessage[] = agents.heldBy(id).map((h) => {
      const target = sessions.find((s) => s.id === h.to)
      return { message_id: h.message_id, to: h.to, to_name: target ? sessionLabel(target) : h.to, at: h.at, ...(h.halted ? { halted: h.halted } : {}) }
    })
    return {
      stopped: agents.isStopped(id),
      sent: turn ? agents.sentInTurn(id, turn) : 0,
      limit: AGENT_SEND_MAX,
      read_tokens: turn ? agents.readInTurn(id, turn) : 0,
      read_budget: AGENT_TURN_READ_BUDGET,
      recent,
      ...(held.length > 0 ? { held } : {}),
    }
  }

  /**
   * `POST /api/sessions/<id>/agent/stop` と `.../agent/resume`（#311）。人が画面から、そのセッションが別のセッションへ送るのを
   * 止める・再開する。同一オリジンのみ。止めたら、そのセッションから送られて預かりに並んでいる分も取り消す
   * （相手でもう回っているターンは止めない。動いている CLI を殺すと、相手の会話が途中で切れる）
   */
  const agentStop = async (req: IncomingMessage, res: ServerResponse, id: string, stop: boolean) => {
    if (isCrossOrigin(req)) return error(res, 403, 'cross-origin request rejected')
    let cancelled = 0
    if (stop) {
      agents.stop(id)
      cancelled = queue.removeWhere((_to, item) => item.origin !== undefined && agents.get(item.origin)?.from === id)
      // まだ送っていない預かり（#727）も捨てる。依頼の残りはここで止まる
      cancelled += agents.dropHeldBy(id)
      await appendFile(join(store.directory, 'reply.log'), `--- ${new Date().toISOString()} ${id} 人がメッセージの送信を止めた（預かりから ${cancelled} 件取り消した）\n`).catch(() => {})
    } else {
      agents.resume(id)
    }
    const { sessions } = await sessionsWithMeta(QUEUE_DAYS)
    const idle: AgentActivity = { stopped: false, sent: 0, limit: AGENT_SEND_MAX, read_tokens: 0, read_budget: AGENT_TURN_READ_BUDGET, recent: [] }
    const payload: AgentStopResponse = { id, agent: (await agentActivityOf(id, sessions)) ?? idle, cancelled }
    return json(res, payload)
  }


  // ---- ループ（#634）

  const loopLog = (id: string, message: string) => appendFile(join(store.directory, 'reply.log'), `--- ${new Date().toISOString()} ${id} ループ: ${message}\n`).catch(() => {})
  /** 失敗で一時停止したあと「再開」を押したときの、その失敗（`Replying.since`）。同じ失敗でもう一度止めない */
  const loopResumedFailure = new Map<string, string>()

  /** 回っているループを一時停止する（人が送った・人がターンを止めた）。回っていなければ何もしない */
  const pauseLoop = async (id: string, reason: string): Promise<void> => {
    const l = loops.get(id)
    if (l?.status !== 'running') return
    loops.set(id, loopHalt(l, 'paused', `${reason}。続けるなら「再開」`))
    await loopLog(id, `一時停止（${reason}）`)
  }

  /**
   * そのセッションにループを組めない・周を起こせない理由。無ければ空。組むときと、周を起こす直前の両方で見る
   * （組んだあとに端末で開いた・許可モードを素通しにした、も止める）。
   *
   * - **Claude だけ**: エージェントが「次」を言う口（`sai_loop_next`）は SAI が `claude -p` に渡す MCP にしか無い
   * - **端末で開いているセッションには組まない**: 打ち込む経路には MCP が無く、端末の `/loop` と二重に回るのを見分けられない
   * - **ルールに関係なく通るモード（`bypassPermissions` / `auto`。#691）には組まない**: 人が見ていない間に、何も聞かれずに回り続ける。
   *   運用者が `SAI_CLAUDE_ARGS` で渡しているときも同じ（`skipModeInArgs()`。1 語の形も見る）。判定は `modeSkipsRules()` の 1 つ
   */
  const loopRefusal = async (session: SessionSummary, kind: 'loop' | 'wait' = 'loop'): Promise<string> => {
    // 待ち（#732）も同じ線を引く（人が見ていない間に SAI が起こすターン）。言い回しだけ変える
    const cannot = kind === 'loop' ? 'ループを組めません' : '待ちを預かれません'
    if (session.archived) return `アーカイブ済みのセッションには${cannot}`
    const blocked = replyBlockedReason(session, selfHost())
    if (blocked) return blocked
    if (session.agent !== 'claude') return kind === 'loop' ? 'ループを組めるのは、いまは Claude のセッションだけです' : '待ちを預かれるのは、いまは Claude のセッションだけです'
    const extra = splitArgs(process.env.SAI_CLAUDE_ARGS)
    if (process.env.SAI_APPROVE === '0' || extra.includes('--permission-prompt-tool')) return kind === 'loop' ? 'SAI の MCP を渡していない（SAI_APPROVE=0 など）ので、エージェントが次を言う口がありません' : 'SAI の MCP を渡していない（SAI_APPROVE=0 など）ので、待ちを預かれません'
    const mode = await replyMode(await metaStore.get(session.id))
    const skips = modeSkipsRules(mode) ? mode : skipModeInArgs(extra)
    if (skips) return `許可を聞かないモード（${modeName(skips)}）のセッションには${cannot}`
    if (await terminalOf(session)) return kind === 'loop' ? '端末で開いているセッションにはループを組めません（端末の /loop と二重に回るのを避けるため）' : '端末で開いているセッションには待ちを預かれません（起こすときに端末へ打ち込むことになるため）'
    return ''
  }

  /**
   * ループを 1 つ進める。周のターンが終わっていれば次の時刻を決め（`loopAfterRound()`）、時刻が来ていれば次の周を起こす。
   *
   * - 起こす経路は返信と同じ `launch()`（`replyBlockedReason()`・モデル・許可モードはそのまま。**SAI は権限のフラグを足さず、
   *   許可も自動で返さない**）。許可・質問で止まっている間はターンが回っているので、次の周は起こさない
   * - **周を送る前に「送った」を書く**（`turn: 'pending'`）。そのまま落ちても、立て直したあとは「その周は終わった」として
   *   次の時刻を待つので、同じ周を 2 回は送らない
   * - 前のターンが回っている・預かりが残っている間は待つ。周のターンが失敗したら止める
   * - 止める歯止め: 終わりの時刻・周の上限・使用量の枠（`usageRefusal()`）・申し送りが変わらない（`loopAfterRound()`）
   */
  const tickLoop = async (id: string): Promise<void> => {
    const l = loops.get(id)
    if (!l) return
    const now = loopNow()
    // **読んだあとに await を挟んだら、書く前にもう一度見る**（#640 のレビュー）: その間に人が止めた・片付けた・一時停止したなら、
    // 古い状態で上書きしない（止めたループを `running` に戻して次の周を起こさない）。置き場は書くたびに新しい値を入れるので、同じ値かで分かる
    const moved = () => loops.get(id) !== l
    const halt = async (state: LoopState, status: Exclude<LoopState['status'], 'running'>, reason: string) => {
      if (moved()) return
      loops.set(id, loopHalt(state, status, reason))
      await loopLog(id, `${status}（${reason}）`)
    }
    if (l.turn) {
      if (run.running(id) || launching.has(id)) return
      const r = run.snapshot()[id]
      if (r?.failed && (l.turn === 'pending' || r.since === l.turn)) return halt(l, 'stopped', `${l.round} 周目のターンが失敗しました（${replyFailureText(r.failed)}）`)
      const next = loopAfterRound(l, now)
      loops.set(id, next)
      await loopLog(id, `${l.round} 周目が終わった（${next.status}${next.next_at ? `。次は ${next.next_at}` : ''}${next.reason ? `。${next.reason}` : ''}）`)
      return
    }
    if (l.status !== 'running' || !l.next_at || Date.parse(l.next_at) > now) return
    if (now >= Date.parse(l.deadline)) return halt(l, 'stopped', '終わりの時刻になりました')
    if (l.round >= l.max_rounds) return halt(l, 'stopped', `上限の ${l.max_rounds} 周を回りました`)
    if (run.running(id) || codexApp.running(id) || opencodeApp.running(id) || typed.running(id) || launching.has(id) || queue.size(id) > 0) return
    const failed = failedReply(id)
    if (failed && loopResumedFailure.get(id) !== failed.since) return halt(l, 'paused', '前の返信が失敗しています。確かめてから「再開」してください')
    const { sessions } = await sessionsWithMeta(QUEUE_DAYS)
    const session = sessions.find((s) => s.id === id)
    if (!session) return halt(l, 'paused', 'セッションが記録の窓に見つかりません')
    const refusal = await loopRefusal(session)
    if (refusal) return halt(l, 'paused', refusal)
    const over = usageRefusal(await usageStore.get(), session.agent)
    if (over) return halt(l, 'stopped', over)
    if (moved()) return
    const { next_at: _next, said: _said, ...rest } = l
    const sending: LoopState = { ...rest, round: l.round + 1, turn: 'pending' }
    loops.set(id, sending)
    const out = await launch(id, loopPrompt(sending, now), [], { days: QUEUE_DAYS, replaceTyped: false, forceProcess: true, url: l.url ?? '', queue: false, loop: true })
    // その間に人が止めた・片付けたなら、そちらを残す
    const cur = loops.get(id)
    if (!cur || cur.turn !== 'pending') return
    if (out.status === 202) {
      loops.set(id, { ...cur, turn: run.snapshot()[id]?.since ?? 'pending' })
      await loopLog(id, `${sending.round} 周目を起こした`)
      return
    }
    // `claude --bg` のターンを待っている（#462）。止めずに、次に見に来たときにもう一度
    if (out.retry) {
      // ここまで来たのは、置き場がまだ自分の書いた `sending` のとき（上で見ている）
      loops.set(id, l)
      return
    }
    loops.set(id, loopHalt(l, 'paused', `${sending.round} 周目を起こせませんでした: ${(out.body as ReplyError).error}`))
    await loopLog(id, `paused（${sending.round} 周目を起こせなかった）`)
  }

  let loopTicking = false
  let loopTimer: ReturnType<typeof setInterval> | undefined
  const loopTickMs = terminal.loopTickMs ?? LOOP_TICK_MS
  /** 見に行く相手がいる間だけタイマーを立てる（画面を開いていなくても回るように。プロセスは引き留めない） */
  const syncLoopTimer = (): void => {
    const want = loopTickMs > 0 && loops.active().length > 0
    if (want && !loopTimer) {
      loopTimer = setInterval(() => void tickLoops().catch(() => {}), loopTickMs)
      loopTimer.unref()
    } else if (!want && loopTimer) {
      clearInterval(loopTimer)
      loopTimer = undefined
    }
  }
  /** 組んであるループを全部見る。タイマーと、画面のポーリングのついでに呼ぶ（重なっても 1 本だけ） */
  const tickLoops = async (): Promise<void> => {
    if (loopTicking) return
    loopTicking = true
    try {
      for (const [id] of loops.active()) await tickLoop(id)
    } finally {
      loopTicking = false
      syncLoopTimer()
    }
  }
  syncLoopTimer()

  /**
   * 人がループを組む・止める・再開する・いま起こす・片付ける（#634）。**同一オリジンのみ**（返信と同じ理由。組むと CLI を起こす）。
   * `cwd` もパスも受けない（周は返信と同じ経路で、セッションの行から起こす）
   */
  const loopAction = async (req: IncomingMessage, res: ServerResponse, id: string, suffix: (typeof LOOP_SUFFIXES)[number]) => {
    if (isCrossOrigin(req)) return error(res, 403, 'cross-origin request rejected')
    const method = req.method ?? 'GET'
    const cur = loops.get(id)
    const at = new Date(loopNow()).toISOString()
    if (suffix === '/loop') {
      if (method === 'DELETE') {
        if (!loops.delete(id)) return error(res, 404, 'このセッションにループは組まれていません')
        await loopLog(id, '人が片付けた')
      } else {
        if (method !== 'POST') return error(res, 405, 'method not allowed')
        if (cur && loopLive(cur.status)) return error(res, 409, 'もうループが組まれています。止めてから組み直してください')
        let body: unknown
        try {
          body = await readJson(req, MAX_REPLY_BYTES)
        } catch (err) {
          return error(res, 400, err instanceof Error ? err.message : 'bad body')
        }
        const made = loopFromRequest(body, loopNow())
        if ('error' in made) return error(res, 400, made.error)
        const { sessions } = await sessionsWithMeta(QUEUE_DAYS)
        const session = sessions.find((s) => s.id === id)
        if (!session) return error(res, 404, 'session not found in window')
        const refusal = await loopRefusal(session)
        if (refusal) return error(res, 400, refusal)
        loops.set(id, { ...made.loop, url: selfUrl(req) })
        await loopLog(id, `人が組んだ（上限 ${made.loop.max_rounds} 周・${made.loop.deadline} まで・既定の間隔 ${made.loop.interval_s} 秒）`)
        await tickLoops()
      }
    } else {
      if (method !== 'POST') return error(res, 405, 'method not allowed')
      if (!cur) return error(res, 404, 'このセッションにループは組まれていません')
      if (suffix === '/loop/stop') {
        if (!loopLive(cur.status)) return error(res, 409, 'このループはもう終わっています')
        // 回っている周のターンは止めない（止めるのは見出しの「止める」）。次の周を起こさないだけ
        loops.set(id, loopHalt(cur, 'stopped', '人が止めました'))
        await loopLog(id, '人が止めた')
      } else if (suffix === '/loop/resume') {
        if (cur.status !== 'paused') return error(res, 409, '一時停止しているループだけ再開できます')
        const failed = failedReply(id)
        if (failed) loopResumedFailure.set(id, failed.since)
        const { reason: _reason, ...rest } = cur
        loops.set(id, { ...rest, status: 'running', stalled: 0, url: selfUrl(req), ...(cur.turn ? {} : { next_at: at }) })
        await loopLog(id, '人が再開した')
        await tickLoops()
      } else {
        if (cur.status !== 'running' || cur.turn) return error(res, 409, 'いま起こせるのは、次の周を待っているループだけです')
        loops.set(id, { ...cur, next_at: at })
        await loopLog(id, '人がいま起こした')
        await tickLoops()
      }
    }
    syncLoopTimer()
    const payload: LoopResponse = { id, loop: loops.snapshot()[id] ?? null }
    return json(res, payload)
  }

  /**
   * `POST /api/agent/loop`（`sai_loop_next`。#634）。エージェントが周の終わりに「続ける（何秒後・申し送り）／終わり／諦める」を言う。
   * **動かせるのは、自分に組まれたループの、いま回っている周だけ**（送り元は `agentFrom()`＝SAI が起こしていま回しているターン。
   * 別のセッションのループ・周でないターン・上限・目的は動かせない）。間隔は SAI が丸める
   */
  const agentLoopNext = async (req: IncomingMessage, res: ServerResponse) => {
    const refusal = agentRefusal(req)
    if (refusal) return error(res, 403, refusal)
    let body: unknown
    try {
      body = await readJson(req, MAX_REPLY_BYTES)
    } catch (err) {
      return error(res, 400, err instanceof Error ? err.message : 'bad body')
    }
    const b = (body ?? {}) as Partial<LoopNextRequest>
    const found = await agentFrom(b.from)
    if (typeof found === 'string') return error(res, 409, found)
    const id = found.session.id
    const l = loops.get(id)
    if (!l || !l.turn || (l.turn !== 'pending' && l.turn !== found.turn)) return error(res, 409, 'このターンはループの周ではありません（動かせるのは、自分に組まれたループの、いま回っている周だけです）')
    const note = typeof b.note === 'string' ? b.note.trim() : ''
    if (note.length > LOOP_NOTE_MAX) return error(res, 400, `note は ${LOOP_NOTE_MAX} 字までです。短くまとめてください`)
    if (b.action === 'continue') {
      const seconds = clampInterval(b.seconds, l.interval_s)
      loops.set(id, { ...l, said: { seconds, note } })
      await loopLog(id, `${l.round} 周目: 続ける（${seconds} 秒後）`)
      const payload: LoopNextResponse = { status: l.status, round: l.round, max_rounds: l.max_rounds, ...(l.round < l.max_rounds ? { next_in_s: seconds } : {}) }
      return json(res, payload)
    }
    if (b.action !== 'done' && b.action !== 'give_up') return error(res, 400, 'action は continue / done / give_up のどれかです')
    if (!note) return error(res, 400, b.action === 'done' ? 'note に、終わりの条件を満たした根拠を書いてください' : 'note に、進められない理由を書いてください')
    const status = b.action === 'done' ? 'done' : 'gave_up'
    loops.set(id, loopHalt(l, status, note))
    await loopLog(id, `${l.round} 周目: ${status}`)
    const payload: LoopNextResponse = { status, round: l.round, max_rounds: l.max_rounds }
    return json(res, payload)
  }

  // ---- 待ち（#732）: 「PR の CI が終わったら、そのセッションを 1 回起こす」

  const waitLog = (id: string, message: string) => appendFile(join(store.directory, 'reply.log'), `--- ${new Date().toISOString()} ${id} 待ち: ${message}\n`).catch(() => {})
  const waitIso = (ms: number) => new Date(ms).toISOString()
  /** 終わったのに起こせなかった待ちを、次に見に行く時刻（待ちの id → ms） */
  const waitRetryAt = new Map<string, number>()
  const WAIT_RETRY_MS = 10_000
  const WAIT_BG_RETRY_MS = 30_000
  const WAIT_SLOW_RETRY_MS = 60_000
  /** 起こせなかった理由の種類（待ちの id → 種類）。同じ種類のあいだは置き場を書き直さない */
  const waitHeldFor = new Map<string, string>()
  /** いま回しているターンの本文（SAI が頭に足した返答の塊は外す）。待ちで起きたターン・ループの周かを見る */
  const turnTextOf = (id: string): string => splitHandedReplies(run.snapshot()[id]?.text ?? '').text

  /**
   * 終わった待ちでセッションを起こす。起こせたら空、起こさなかったら理由（待ちに `reason` として残る）。
   *
   * - 起こす経路は返信・ループと同じ `launch()`（**SAI は権限のフラグを足さず、許可も自動で返さない**）。断る線もループと同じ `loopRefusal()`
   * - 処理中・預かりが残っている・前の返信が失敗しているセッションは追い越さない（終わる・片付くまで `ready` のまま待つ）
   * - 使用量の枠が残り少ない・1 日の回数を超えたときは起こさない。**人の「いま起こす」（`forced`）だけがこの 2 つを越える**
   * - 読み直す量が大きければ要約してから起こす（#579 と同じ `canCompact()`。本文は預かりの先頭に置かれ、要約のあとに回る）
   * - **起こす前に `waking` を書く**。その途中で立て直されたら、届いたか分からないので送り直さない（`WaitStore` が `halted` にする）。
   *   起こせた待ちは消す（1 つの待ちで起こすのは 1 回）
   */
  const wakeWait = async (id: string, waitId: string, forced: boolean): Promise<string> => {
    const w = waits.get(id, waitId)
    if (!w) return 'その待ちはもうありません'
    const now = loopNow()
    // 読んだあとに await を挟んだら、書く前にもう一度見る（その間に人が止めたものを戻さない）
    const moved = () => waits.get(id, waitId) !== w
    const hold = (reason: string, kind: string, slow = false): string => {
      // 人の「いま起こす」で起こせなかったときは、待ちには書かない（押した人に理由を返すだけ。「終わったら起こします」は
      // 自動で見に行く待ちにしか当てはまらない）
      if (forced) return reason
      // 起こせない間は、見に行くたびに記録や使用量を読み直さない。枠・回数のように長く続く理由は間を空ける
      waitRetryAt.set(waitId, now + (slow ? WAIT_SLOW_RETRY_MS : WAIT_RETRY_MS))
      // 同じ種類の理由なら書き直さない（使用量の文は割合が入るので、動くたびに書くと rev が進んで画面が描き直す）
      if (!moved() && waitHeldFor.get(waitId) !== kind) {
        waitHeldFor.set(waitId, kind)
        waits.set(id, { ...w, reason })
      }
      return reason
    }
    if (run.running(id) || codexApp.running(id) || opencodeApp.running(id) || typed.running(id) || launching.has(id) || queue.size(id) > 0) return hold('セッションが処理中です（終わったら起こします）', 'busy')
    if (failedReply(id)) return hold('前の返信が失敗しています（確かめて片付けたら起こします）', 'failed')
    // ここから先の読み取り（記録・端末の走査・使用量・transcript）が失敗しても、理由を残して間を空ける（黙って 5 秒ごとに繰り返さない）
    let session: SessionSummary | undefined
    let context = 0
    try {
      session = (await sessionsWithMeta(QUEUE_DAYS)).sessions.find((s) => s.id === id)
      if (!session) return hold('セッションが記録の窓に見つかりません', 'gone', true)
      const refusal = await loopRefusal(session, 'wait')
      if (refusal) return hold(refusal, 'refused', true)
      if (!forced) {
        const over = usageRefusal(await usageStore.get(), session.agent)
        if (over) return hold(`${over}（枠が戻ったら起こします。「いま起こす」でも起こせます）`, 'usage', true)
        if (wakesExhausted(waits.wakesOf(id, now), now)) return hold(`待ちで自動で起こすのは 24 時間に ${WAIT_WAKES_PER_DAY} 回までです（「いま起こす」で起こせます）`, 'daily', true)
      }
      context = (await progress.read(session)).context_tokens
    } catch (err) {
      return hold(`起こす前の確認で失敗しました（もう一度見に行きます）: ${err instanceof Error ? err.message : String(err)}`, 'error', true)
    }
    if (moved()) return 'その待ちは変わりました'
    const { reason: _reason, next_check_at: _next, ...rest } = w
    const sending: WaitState = { ...rest, status: 'waking' }
    waits.set(id, sending)
    const text = waitPrompt(sending)
    const compact = canCompact({ agent: session.agent, contextTokens: context, terminal: Boolean(session.terminal) })
    let out: Launched
    try {
      out = await launch(id, text, [], { days: QUEUE_DAYS, replaceTyped: false, forceProcess: true, url: w.url ?? '', queue: false, ...(compact ? { compact: true, compactFrom: text } : {}) })
    } catch (err) {
      // 起こす途中で例外になっても `waking` のまま残さない（残すと、誰も見に行かず枠も使い続ける）
      out = { status: 500, body: { error: err instanceof Error ? err.message : String(err) } }
    }
    // その間に人が止めた（消した）なら、そちらを残す
    if (waits.get(id, waitId) !== sending) return ''
    if (out.status === 202) {
      waits.remove(id, waitId)
      waitRetryAt.delete(waitId)
      waitHeldFor.delete(waitId)
      if (!forced) waits.woke(id, now)
      await waitLog(id, `PR #${w.pr} で起こした（${waitResultText(w.result) || '人がいま起こした'}${compact ? '。要約してから' : ''}${forced ? '。人の「いま起こす」' : ''}）`)
      return ''
    }
    // `claude --bg` のターンを待っている（#462）。止めずに、少し置いてからもう一度（毎回見に行くと置き場を書き続ける）
    if (out.retry) {
      waits.set(id, w)
      waitRetryAt.set(waitId, now + WAIT_BG_RETRY_MS)
      return 'retry'
    }
    // 上で見たあとに人が返信した（409）。処理中と同じ扱いで、終わったらもう一度（止めっぱなしにしない）
    if (out.status === 409 && !forced && w.status === 'ready') {
      waits.set(id, { ...w, reason: 'セッションが処理中です（終わったら起こします）' })
      waitHeldFor.set(waitId, 'busy')
      waitRetryAt.set(waitId, now + WAIT_RETRY_MS)
      return (out.body as ReplyError).error
    }
    const why = `起こせませんでした: ${(out.body as ReplyError).error}`
    // 人の「いま起こす」で起こせなかったときは、待ちを元に戻す（確かめている途中の待ちを止めっぱなしにしない。理由は押した人に返す）
    if (forced) {
      waits.set(id, w)
      return why
    }
    waits.set(id, { ...rest, status: 'halted', reason: why })
    await waitLog(id, `PR #${w.pr}: ${why}`)
    return why
  }

  /**
   * 待ちを 1 つ進める。確かめる時刻が来ていれば `gh` で読み（**決まった形の 1 本だけ**。エージェントのターンは回さない）、
   * 終わっていれば（緑でも赤でも）起こしに行く。待てる時間を過ぎたら起こさずに `expired` にして画面に残す
   */
  const tickWait = async (id: string, waitId: string): Promise<void> => {
    const w = waits.get(id, waitId)
    if (!w || w.status === 'waking' || !waitLive(w.status)) return
    const now = loopNow()
    if (w.status === 'waiting') {
      const late = now >= Date.parse(w.deadline)
      if (!late && w.next_check_at && Date.parse(w.next_check_at) > now) return
      // 待てる時間を過ぎていても、最後に 1 回は読む（サーバが止まっていた・Mac が眠っていた間に終わっていることがある）
      const ci = prs.ci ? await prs.ci(w.repo, w.pr) : null
      if (waits.get(id, waitId) !== w) return
      const seen = ci ? waitOutcome(ci, Date.parse(w.since), now) : null
      // 「通った」「落ちた」は 1 回見ただけでは信じない（push・回し直しの直後は、前の結果や速いチェックだけが載っていることがある）。
      // 次に確かめたときも同じなら終わり。最後の 1 回（時間切れ）のときはそのまま信じる
      const outcome = waitConfirmed(seen, w.seen_once, late)
      const { reason: _reason, seen_once: _seen, next_check_at: _next, ...rest } = w
      if (!outcome) {
        if (late) {
          waits.set(id, { ...rest, status: 'expired', reason: `${Math.round(WAIT_MAX_MS / 60_000)} 分待ちましたが、CI が終わりませんでした` })
          await waitLog(id, `PR #${w.pr}: 待てる時間を過ぎた（起こしていない）`)
          return
        }
        waits.set(id, {
          ...rest,
          next_check_at: waitIso(now + WAIT_POLL_MS),
          ...(seen === 'success' || seen === 'failure' ? { seen_once: seen } : {}),
          ...(ci ? { checked_at: waitIso(now) } : { reason: 'gh で読めませんでした（次にもう一度確かめます）', ...(w.seen_once ? { seen_once: w.seen_once } : {}) }),
        })
        return
      }
      waits.set(id, { ...rest, status: 'ready', result: outcome, failing: ci!.failing.slice(0, WAIT_FAILING_MAX), checked_at: waitIso(now) })
      await waitLog(id, `PR #${w.pr}: ${waitResultText(outcome)}`)
    } else {
      // 終わったのに起こせないまま長く経ったら、見に行くのをやめる（起こせない待ちが同時の数の枠を使い続けない）
      if (now - Date.parse(w.checked_at ?? w.since) >= WAIT_READY_MAX_MS) {
        waits.set(id, { ...w, status: 'halted', reason: `終わってから ${Math.round(WAIT_READY_MAX_MS / 3_600_000)} 時間、起こせませんでした（${w.reason ?? '理由は分かりません'}）` })
        await waitLog(id, `PR #${w.pr}: 終わってから起こせないまま時間切れ`)
        return
      }
      if ((waitRetryAt.get(waitId) ?? 0) > now) return
    }
    await wakeWait(id, waitId, false)
  }

  let waitTicking = false
  let waitTimer: ReturnType<typeof setInterval> | undefined
  const waitTickMs = terminal.loopTickMs ?? WAIT_TICK_MS
  /** 見に行く相手がいる間だけタイマーを立てる（画面を開いていなくても確かめる。ループと同じ形） */
  const syncWaitTimer = (): void => {
    const want = waitTickMs > 0 && waits.live().length > 0
    if (want && !waitTimer) {
      waitTimer = setInterval(() => void tickWaits().catch(() => {}), waitTickMs)
      waitTimer.unref()
    } else if (!want && waitTimer) {
      clearInterval(waitTimer)
      waitTimer = undefined
    }
  }
  const tickWaits = async (): Promise<void> => {
    if (waitTicking) return
    waitTicking = true
    try {
      for (const [id, w] of waits.live()) await tickWait(id, w.id).catch(() => {})
    } finally {
      waitTicking = false
      syncWaitTimer()
    }
  }
  syncWaitTimer()

  /**
   * `POST /api/agent/wait-for`（`sai_wait_for`。#732）。エージェントが「PR の CI が終わったら起こして」を預ける。
   * **預けられるのは、SAI が起こしていま回しているターンの自分のセッションだけ**（`agentFrom()`）。受けるのは PR の番号と
   * 起きたときにやることの 1 文で、リポジトリはセッションの行の remote から決める（**記録で知っているものだけ**。名前は受けない）。
   * 長さ・間隔・回数を動かす引数は無い。もう終わっていれば預からずに結果を返す（起こす 1 回を使わない）
   */
  const agentWaitFor = async (req: IncomingMessage, res: ServerResponse) => {
    const refusal = agentRefusal(req)
    if (refusal) return error(res, 403, refusal)
    let body: unknown
    try {
      body = await readJson(req, MAX_REPLY_BYTES)
    } catch (err) {
      return error(res, 400, err instanceof Error ? err.message : 'bad body')
    }
    const b = (body ?? {}) as Partial<WaitForRequest>
    const found = await agentFrom(b.from)
    if (typeof found === 'string') return error(res, 409, found)
    const id = found.session.id
    // 待ちで起きたターンから次の待ちを預けさせない（起きたときにやってよいのは報告まで。待ち → 起きる → 待ち、を自動で回さない）
    const turnText = turnTextOf(id)
    if (isWaitPrompt(turnText)) return error(res, 409, '待ちで起きたターンからは、次の待ちを預けられません（結果を報告して終えてください）')
    if (loops.get(id)?.turn) return error(res, 409, 'ループの周からは待ちを預けられません（次に起きる時刻は sai_loop_next で言ってください）')
    if (agents.isStopped(id)) return error(res, 409, '人がこのセッションからの送信を止めているので、待ちも預かれません')
    const made = waitFromRequest(b)
    if ('error' in made) return error(res, 400, made.error)
    const blocked = await loopRefusal(found.session, 'wait')
    if (blocked) return error(res, 400, blocked)
    const repo = githubRepoOf(found.session.remote)
    if (!repo) return error(res, 400, 'このセッションのリポジトリ（origin）が GitHub のものと分からないので、PR を確かめられません')
    if (!prs.available || !prs.ci) return error(res, 400, 'gh を使わない設定（SAI_GH=0）なので、CI を確かめられません')
    const limit = waitLimitRefusal(waits.of(id), repo, made.pr)
    if (limit) return error(res, 429, limit)
    // 預かる前に 1 回読む: 番号違い・gh が使えない、を黙って待たない。もう終わっていれば預からない
    const ci = await prs.ci(repo, made.pr)
    if (!ci) return error(res, 400, `PR #${made.pr}（${repo}）を gh で読めませんでした（番号と gh のログインを確かめてください）`)
    const now = loopNow()
    const left = () => Math.max(0, WAIT_MAX_PER_SESSION - waits.of(id).filter((w) => waitLive(w.status)).length)
    // 預かった時刻を now にすると「チェックがまだ載っていない」の猶予が効くので、ここでは猶予を見ない（載っていなければ待つ）
    // **「通った」「落ちた」はここでは信じない**（push・回し直しの直後は、前の結果や速いチェックだけが載っていることがある）。
    // 預かって、次に確かめたときも同じなら起こす。マージ済み・クローズは、あとから変わらないのでその場で返す
    const outcome = waitOutcome(ci, now, now)
    if (outcome === 'merged' || outcome === 'closed') {
      const payload: WaitForResponse = { result: outcome, failing: ci.failing.slice(0, WAIT_FAILING_MAX), left: left() }
      return json(res, payload)
    }
    // await を挟んだので、数の上限はもう一度見る（ツールを並べて呼ばれても超えない）
    const again = waitLimitRefusal(waits.of(id), repo, made.pr)
    if (again) return error(res, 429, again)
    const wait: WaitState = {
      id: randomUUID().replace(/-/g, '').slice(0, 16),
      repo,
      pr: made.pr,
      then: made.then,
      status: 'waiting',
      since: waitIso(now),
      deadline: waitIso(now + WAIT_MAX_MS),
      checked_at: waitIso(now),
      next_check_at: waitIso(now + WAIT_POLL_MS),
      url: selfUrl(req),
      ...(outcome === 'success' || outcome === 'failure' ? { seen_once: outcome } : {}),
    }
    waits.add(id, wait)
    await waitLog(id, `PR #${made.pr}（${repo}）の CI を待つ（${wait.deadline} まで）`)
    syncWaitTimer()
    const payload: WaitForResponse = { wait: waits.snapshot()[id]!.find((w) => w.id === wait.id)!, left: left() }
    return json(res, payload)
  }

  /**
   * 人が待ちを止める（`/wait/stop`）・いま起こす（`/wait/wake`）（#732）。**同一オリジンのみ**（起こすと CLI が動く）。
   * 止めるは、状態に関係なくその待ちを消す（終わった・起こせなかった待ちの片付けも同じ口）。
   * いま起こすは、使用量の枠と 1 日の回数だけを越える。処理中・前の返信の失敗・許可を聞かないモードは越えない
   */
  const waitAction = async (req: IncomingMessage, res: ServerResponse, id: string, suffix: (typeof WAIT_SUFFIXES)[number]) => {
    if (isCrossOrigin(req)) return error(res, 403, 'cross-origin request rejected')
    if ((req.method ?? 'GET') !== 'POST') return error(res, 405, 'method not allowed')
    let body: unknown
    try {
      body = await readJson(req, MAX_REPLY_BYTES)
    } catch (err) {
      return error(res, 400, err instanceof Error ? err.message : 'bad body')
    }
    const waitId = (body as Partial<WaitActionRequest> | null)?.wait
    const cur = typeof waitId === 'string' ? waits.get(id, waitId) : undefined
    if (!cur) return error(res, 404, 'その待ちはありません（もう起こしたか、止めてあります）')
    if (suffix === '/wait/stop') {
      waits.remove(id, cur.id)
      waitRetryAt.delete(cur.id)
      waitHeldFor.delete(cur.id)
      await waitLog(id, `PR #${cur.pr}: 人が止めた`)
    } else {
      if (!waitWakeable(cur.status)) return error(res, 409, cur.status === 'waking' ? 'いま起こしています' : 'この待ちは起こせません（片付けてください）')
      const why = await wakeWait(id, cur.id, true)
      if (why) return error(res, 409, why === 'retry' ? 'いまは起こせません。少し待ってからもう一度押してください' : why)
    }
    syncWaitTimer()
    const payload: WaitActionResponse = { id, waits: waits.snapshot()[id] ?? [] }
    return json(res, payload)
  }

  // ---- tailnet から MCP で呼ぶ口（#312）

  /** tailnet から送った回数（呼んだ人ごと） */
  // 立て直しても 10 分 5 回の枠を数え直さない（#440）
  const mcpLimiter = new McpSendLimiter(Date.now, join(store.directory, MCP_SENDS_FILE))
  /** sai_sessions が見る日数 */
  const MCP_LIST_DAYS = 7
  /**
   * sai_wait がサーバ側で待つ既定と上限（秒）。Serve を通る 1 本の HTTP を長く握らないように短めにし、
   * まだならエージェントにもう一度呼ばせる（stdio の sai_wait は最長 30 分繰り返すが、HTTP は間に Serve がいる）
   */
  const MCP_WAIT_DEFAULT_S = 60
  const MCP_WAIT_MAX_S = 120
  const MAX_MCP_BYTES = 256 * 1024
  /** tailnet の MCP から来たメッセージの送り元（sai_wait で本人を確かめる鍵）。セッションの id と混ざらない形 */
  const mcpFrom = (access: McpAccess) => `mcp:${access.caller}`
  const mcpBusy = (id: string) => run.running(id) || codexApp.running(id) || opencodeApp.running(id) || typed.running(id)
  const mcpStr = (v: unknown) => (typeof v === 'string' ? v : '')
  const mcpNum = (v: unknown, fallback: number, min: number, max: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(max, Math.max(min, Math.floor(v))) : fallback)

  /**
   * tailnet から送れない相手なら理由。アーカイブ済み・返信できない（別のマシン・合成 ID など）に加えて、
   * **ルールに関係なく通るモード（bypassPermissions / auto）を選んだセッションには送らない**（tailnet の呼び出し元の LLM が、許可を聞かないエージェントを動かせてしまう。#253 / #691）
   */
  const mcpSendRefusal = (s: SessionSummary, byDefault: string): string => {
    if (s.archived) return 'アーカイブ済み'
    const blocked = replyBlockedReason(s, selfHost())
    if (blocked) return blocked
    // 設定の既定が素通しなら、メタに何も無いセッションも素通しで回る（#582）。既定が付くのは Claude だけ
    // （`--permission-mode` を渡す先が無い Codex / OpenCode まで断らない）
    const mode = replyModeOf(s.meta?.permission_mode, s.agent === 'claude' ? byDefault : '')
    if (modeSkipsRules(mode)) return `許可を聞かないモード（${modeName(mode)}）のセッションには tailnet から送れません`
    return ''
  }

  /**
   * `/mcp` の宛先を引く（#625）。**id がそのまま当たればそれ**（送れない・置けない理由は呼び出し側が今までどおり返す）。
   * 当たらなければ、`allowed` を通るセッションの中から呼び名の完全一致で探し、ちょうど 1 つのときだけ返す。決まらなければ断りの文
   */
  const mcpTarget = (sessions: SessionSummary[], asked: string, allowed: (s: SessionSummary) => boolean): SessionSummary | string => {
    const byId = sessions.find((s) => s.id === asked)
    if (byId) return byId
    // 送れない・置けないが居るセッション（素通し・別のマシンなど）に同じ名前があれば、名前では当てない（別の相手に黙って届かせない）
    const resolved = resolveTarget(sessions.filter(allowed), asked, sessions.filter((s) => !s.archived && !allowed(s)))
    if (resolved.target) return resolved.target
    // 候補は当たりが複数のときだけ並べる（tailnet からは全リポジトリが見えるので、無いときに全部は並べない）
    return resolved.ambiguous ? targetRefusal(asked, resolved, '') : 'そのセッションは見つかりません（sai_sessions で確かめてください）'
  }

  /**
   * MCP のツール。読むもの（read）は画面・REST と同じ範囲。案を置く（draft。#565）は入力欄に置くだけでターンを起こさない。
   * 送る・待つ（send）はエージェント用の口（#310）と同じ規則
   * （見出しで人の入力と見分ける・相手が処理中なら預かり・返答は見出しの id で探して切る・受け取ったターンからは先へ送らせない）
   */
  const mcpTools = (req: IncomingMessage, access: McpAccess): McpTool[] => [
    {
      name: 'sai_sessions',
      scope: 'read',
      description: `SAI に並んでいるセッションの一覧（直近 ${MCP_LIST_DAYS} 日、アーカイブ済みを除く）。id・呼び名・リポジトリ・エージェント・ブランチ・処理中か・**いま持っているもの**（空いているか・ブランチから出ている open な PR と CI・ブランチ名や PR の題名・届いている依頼から引けた issue の番号・頼まれてまだ返していない依頼の数。機械で引けたものだけで、無ければ出ない）・待ち（許可・質問）・送れない理由・最後の記録の時刻・最後の発言の 1 行目`,
      inputSchema: { type: 'object', properties: { project: { type: 'string', description: 'リポジトリ（owner/repo）で絞る' } } },
      run: async (args) => {
        const project = mcpStr(args.project)
        const { sessions: all } = await sessionsWithMeta(MCP_LIST_DAYS)
        const list = all.filter((s) => !s.archived && (!project || s.project === project))
        if (list.length === 0) return textResult('セッションはありません')
        // 待ちは画面と同じもの（#323。Manager が本文を読まずに急ぐものを選ぶ）: 端末で人が答えたぶんは畳み（#255）、
        // 返信中の答え待ち（承認のバブル）も足す
        const { sessions } = await settleWaiting(list)
        const pending = await approvalsNow(sessions)
        const byDefault = (await settingsStore.get()).reply_mode
        // いま何を持っているか（#727）。待ち・答え待ち・預かり・処理中（端末で人が回しているターンも）のどれかがあれば空きではない。
        // 送れない相手（別のマシン・素通し・合成 ID など）に「空き」は付けない
        const queued = queue.snapshot()
        const here = sessions.filter((s) => !isRemoteHost(s.host, selfHost()))
        const active = new Map(await Promise.all(here.map(async (s) => [s.id, (await progress.read(s)).active] as const)))
        const holdings = await holdingsOf(
          sessions,
          (s) => mcpBusy(s.id) || Boolean(active.get(s.id)) || Boolean(s.waiting) || (pending[s.id]?.length ?? 0) > 0 || (queued[s.id]?.items.length ?? 0) > 0,
          (s) => !mcpSendRefusal(s, byDefault),
        )
        return textResult(
          sessions
            .map((s) => {
              const e = agentEntry(s, mcpBusy(s.id))
              const why = mcpSendRefusal(s, byDefault)
              const waiting = clipReply((s.waiting || pending[s.id]?.[0]?.text || '').split('\n')[0] ?? '', 120)
              return `- ${e.id}「${e.name}」${e.project} ${e.agent}${e.branch ? ` ${e.branch}` : ''}${e.busy ? '（処理中）' : ''}${holdingLabel(holdings.get(s.id) ?? {})}${waiting ? `（待ち: ${waiting}）` : ''}${why ? `（送れない: ${why}）` : ''}${s.manager_draft ? '（案を置いてある）' : ''} 最後の記録: ${s.end}${e.last_text ? ` 最後の発言: ${e.last_text}` : ''}`
            })
            .join('\n'),
        )
      },
    },
    {
      name: 'sai_session',
      scope: 'read',
      description: 'セッションの直近のやりとり（人の入力とエージェントの返答）。長いものは切る',
      inputSchema: {
        type: 'object',
        properties: { id: { type: 'string', description: 'sai_sessions の id' }, turns: { type: 'number', description: '何ターンぶん（既定 3、最大 10）' } },
        required: ['id'],
      },
      run: async (args) => {
        const id = mcpStr(args.id)
        const turns = (await rowsNow(QUEUE_DAYS)).filter((r) => eventKind(r.event, r.text) === 'turn' && entityId(r.session ?? '', r.repo ?? '', String(r.ts ?? '')) === id)
        if (turns.length === 0) return textResult('そのセッションのターンは見つかりません（sai_sessions の id を渡してください）', true)
        return textResult(
          turns
            .slice(-mcpNum(args.turns, 3, 1, 10))
            .map((r) => `## ${r.ts}\n${r.user_text ? `人: ${clipReply(r.user_text, 500)}\n` : ''}エージェント: ${clipReply(r.text ?? '', 2000)}`)
            .join('\n\n'),
        )
      },
    },
    {
      name: 'sai_progress',
      scope: 'read',
      description: '処理中のセッションが、いま何をしているか（走っているツール・直近の手順）',
      inputSchema: { type: 'object', properties: { id: { type: 'string', description: 'sai_sessions の id' } }, required: ['id'] },
      run: async (args) => {
        const { sessions } = await store.sessions(QUEUE_DAYS)
        const session = sessions.find((s) => s.id === mcpStr(args.id))
        if (!session) return textResult('そのセッションは見つかりません', true)
        if (isRemoteHost(session.host, selfHost())) return textResult('別のマシンのセッションの手順は読めません', true)
        const p = await progress.read(session)
        if (p.steps.length === 0) return textResult('いまの手順はありません（処理中でないか、読めるファイルがありません）')
        return textResult([p.active ? '処理中:' : '動いていません（最後のターンの手順）:', ...p.steps.map((s) => `- ${stepLabel(s)}${s.kind === 'tool' && !s.ended ? '（実行中）' : ''}`)].join('\n'))
      },
    },
    {
      name: 'sai_suggest',
      scope: 'draft',
      description: `宛先のセッションの入力欄に「案」を置く（送らない・ターンを起こさない）。人が画面で見て、入れて送るか捨てるかを決める。1 セッションに 1 つで、置き直すと前の案は消える。24 時間か、人がそのセッションに何か送ると消える。本文は ${AGENT_TEXT_MAX_CHARS} 字まで`,
      inputSchema: { type: 'object', properties: { to: { type: 'string', description: SEND_TO_ARG }, text: { type: 'string', description: '入力欄に置く本文（そのまま送れる形で）' } }, required: ['to', 'text'] },
      run: async (args) => {
        const asked = mcpStr(args.to)
        const text = mcpStr(args.text).trim()
        if (!asked || !text) return textResult('to と text が要ります', true)
        if (text.length > AGENT_TEXT_MAX_CHARS) return textResult(`置けるのは ${AGENT_TEXT_MAX_CHARS} 字までです。短くまとめてください`, true)
        const { sessions } = await sessionsWithMeta(QUEUE_DAYS)
        // 宛先は id か呼び名（#625）。名前で引くのは、案を置ける相手（アーカイブ済みでない・画面に入力欄が出る）の中からだけ
        const found = mcpTarget(sessions, asked, (s) => !s.archived && !replyBlockedReason(s, selfHost()))
        if (typeof found === 'string') return textResult(found, true)
        const target = found
        const to = target.id
        // 別のリポジトリ・素通しのセッションにも置ける（送るのは人なので）。画面に入力欄が出ないものにだけは置かない
        if (target.archived) return textResult('置けません: アーカイブ済み', true)
        const blocked = replyBlockedReason(target, selfHost())
        if (blocked) return textResult(`置けません: ${blocked}`, true)
        // 回っているターンがあれば覚えておく（そのターンの終わりは人の入力ではないので、そこでは消さない）
        const busy = mcpBusy(to) || (await progress.read(target)).active
        await suggestionStore.put(to, text, access.caller, { busy })
        await appendFile(join(store.directory, 'reply.log'), `--- ${new Date().toISOString()} ${mcpFrom(access)} → ${to} 案を置いた（${text.length} 字）\n`).catch(() => {})
        return textResult(`${to}「${sessionLabel(target)}」の入力欄に案を置きました（送ってはいません。人が SAI の画面で見て、入れて送るか捨てるかを決めます）`)
      },
    },
    {
      name: 'sai_send',
      scope: 'send',
      description: `別のセッションに頼む・聞く。相手が処理中なら終わってから回る。返答は sai_wait で受け取る。本文は ${AGENT_TEXT_MAX_CHARS} 字まで。${SEND_COMPACT_NOTE}`,
      inputSchema: {
        type: 'object',
        properties: { to: { type: 'string', description: SEND_TO_ARG }, text: { type: 'string' }, compact: { type: 'boolean', description: SEND_COMPACT_ARG } },
        required: ['to', 'text'],
      },
      run: async (args) => {
        const asked = mcpStr(args.to)
        const text = mcpStr(args.text).trim()
        if (!asked || !text) return textResult('to と text が要ります', true)
        if (text.length > AGENT_TEXT_MAX_CHARS) return textResult(`送れるのは ${AGENT_TEXT_MAX_CHARS} 字までです。短くまとめてください`, true)
        const { sessions } = await sessionsWithMeta(QUEUE_DAYS)
        // 宛先は id か呼び名（#625）。名前で引くのは送れる相手の中からだけ（id なら、送れない理由をそのまま返す）
        const byDefault = (await settingsStore.get()).reply_mode
        const found = mcpTarget(sessions, asked, (s) => !mcpSendRefusal(s, byDefault))
        if (typeof found === 'string') return textResult(found, true)
        const target = found
        const to = target.id
        const why = mcpSendRefusal(target, byDefault)
        if (why) return textResult(`送れません: ${why}`, true)
        const limit = mcpLimiter.refusal(access.caller)
        if (limit) return textResult(limit, true)
        // 相手のエージェントの使用量の枠と、相手に読み直させる量の予算（#311 と同じ規則）。
        // tailnet から呼ぶ側には SAI が起動したターンが無いので、予算は呼んだ人ごとに回数と同じ区切り（10 分）で数える
        const overUsage = usageRefusal(await usageStore.get(), target.agent)
        if (overUsage) return textResult(overUsage, true)
        const context = (await progress.read(target)).context_tokens
        const window = mcpLimiter.windowKey()
        const overBudget = budgetRefusal(agents.readInTurn(mcpFrom(access), window), context)
        if (overBudget) return textResult(overBudget, true)
        const messageId = agents.newId()
        const compact = messageCompactOf(target, text, context, args.compact)
        const out = await launch(to, deliveredFromTailnet(access.caller, messageId, text), [], { days: QUEUE_DAYS, replaceTyped: false, forceProcess: false, url: selfUrl(req), queue: true, origin: messageId, ...compact })
        if (out.status !== 202) return textResult(`送れませんでした: ${(out.body as ReplyError).error}`, true)
        const via = (out.body as ReplyResponse).via
        mcpLimiter.record(access.caller)
        agents.record({ message_id: messageId, from: mcpFrom(access), to, text, since: new Date().toISOString() }, window, context)
        await appendFile(join(store.directory, 'reply.log'), `--- ${new Date().toISOString()} ${mcpFrom(access)} → ${to} メッセージ ${messageId}（${via}）\n`).catch(() => {})
        const size = tokensLabel(context)
        return textResult(
          `${to}「${sessionLabel(target)}」に送りました（message_id: ${messageId}。${sendHow(via)}）。` +
            `${size ? `${via === 'compact' ? '要約の前の相手の文脈は' : '相手が読み直す量は'}${size}（予算の残り ${tokensLabel(Math.max(0, AGENT_TURN_READ_BUDGET - agents.readInTurn(mcpFrom(access), window))) || '0'}）。` : ''}返答は sai_wait で受け取れます`,
        )
      },
    },
    {
      name: 'sai_wait',
      scope: 'send',
      description: `sai_send で送ったメッセージへの返答を待って受け取る（最大 ${MCP_WAIT_MAX_S} 秒。まだならもう一度呼ぶ）`,
      inputSchema: {
        type: 'object',
        properties: { message_id: { type: 'string' }, wait_seconds: { type: 'number', description: `待つ秒数（既定 ${MCP_WAIT_DEFAULT_S}、最大 ${MCP_WAIT_MAX_S}）` } },
        required: ['message_id'],
      },
      run: async (args) => {
        const message = agents.get(mcpStr(args.message_id))
        if (!message || message.from !== mcpFrom(access)) return textResult('そのメッセージは見つかりません（送った本人だけが待てます。SAI を立て直すと見失います）', true)
        const until = Date.now() + mcpNum(args.wait_seconds, MCP_WAIT_DEFAULT_S, 0, MCP_WAIT_MAX_S) * 1000
        for (;;) {
          const result = await agentResult(message)
          if (result) agents.handed([message.message_id])
          if (result?.status === 'done') return textResult(result.text ?? '')
          if (result?.status === 'failed') return textResult(`相手のターンが失敗しました: ${result.error ?? ''}`, true)
          if (Date.now() >= until) return textResult('まだ返答がありません。あとでもう一度 sai_wait を呼んでください')
          await new Promise((r) => setTimeout(r, AGENT_POLL_MS))
        }
      },
    },
  ]

  /**
   * `/mcp`（Streamable HTTP の最小。#312）。POST で 1 通受けて JSON で 1 回返す（SSE・セッションは出さない）。
   * - 使えるツールは身元と tailnet の ACL の capability で決める（`server/mcp/access.ts`）。何も使えなければ 403
   * - **Origin は必ず検査する**（MCP の仕様。DNS rebinding）: 無ければ（CLI・サーバ間）通し、あれば capability の origins に書いたものだけ。CORS もそれにだけ返す
   * - 同一オリジンの検査（`isCrossOrigin()`）は使わない。CLI は Origin を付けないので歯止めにならず、代わりが capability
   */
  const mcpHttp = async (req: IncomingMessage, res: ServerResponse, who: Identity, method: string) => {
    const respond = (status: number, body: unknown, headers: Record<string, string> = {}) => {
      const text = body === undefined ? '' : JSON.stringify(body)
      res.writeHead(status, { ...(text ? { 'Content-Type': 'application/json' } : {}), 'Cache-Control': 'no-store', ...headers })
      res.end(text)
    }
    const access = mcpAccess(who)
    if (access.scopes.size === 0) return respond(403, { error: 'MCP を使う許可がありません（タグ付きの端末は、tailnet の ACL の grants で capability を与えてください）' })
    const originHeader = req.headers.origin
    const origin = typeof originHeader === 'string' ? normalizeOrigin(originHeader) : ''
    if (originHeader !== undefined && (!origin || !access.origins.has(origin))) {
      return respond(403, { error: 'この Origin からは呼べません（tailnet の ACL の grants で origins に書いたページだけ）' })
    }
    const cors: Record<string, string> = origin ? { 'Access-Control-Allow-Origin': origin, Vary: 'Origin' } : {}
    if (method === 'OPTIONS') {
      return respond(204, undefined, {
        ...cors,
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Accept, MCP-Protocol-Version, Mcp-Session-Id',
        'Access-Control-Max-Age': '600',
      })
    }
    if (method !== 'POST') return respond(405, { error: 'POST だけです（SSE の GET とセッションの DELETE は出していません）' }, { ...cors, Allow: 'POST, OPTIONS' })
    if (!protocolVersionOk(req.headers['mcp-protocol-version'])) return respond(400, { error: 'MCP-Protocol-Version が対応していない版です' }, cors)
    let message: unknown
    try {
      message = await readJson(req, MAX_MCP_BYTES)
    } catch (err) {
      return respond(400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: err instanceof Error ? err.message : 'parse error' } }, cors)
    }
    if (Array.isArray(message)) return respond(400, { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'バッチは受けません' } }, cors)
    const response = await handleRpc(message, mcpTools(req, access), access.scopes)
    return response ? respond(200, response, cors) : respond(202, undefined, cors)
  }

  /**
   * POST /api/approvals。返信中の CLI から（server/approvals/approve-mcp.ts 経由で）許可・質問を預かる。
   * 返信を回していないエンティティの分は受けない（誰が投げたか分からないものを画面に出さない）
   */
  const askApproval = async (req: IncomingMessage, res: ServerResponse) => {
    if (isCrossOrigin(req)) return error(res, 403, 'cross-origin request rejected')
    let body: unknown
    try {
      body = await readJson(req, MAX_APPROVAL_BYTES)
    } catch (err) {
      return error(res, 400, err instanceof Error ? err.message : 'bad body')
    }
    const b = (body ?? {}) as Partial<ApprovalRequest>
    if (typeof b.id !== 'string' || !b.id) return error(res, 400, 'id is required')
    if (typeof b.tool_name !== 'string' || !b.tool_name) return error(res, 400, 'tool_name is required')
    if (!b.input || typeof b.input !== 'object' || Array.isArray(b.input)) return error(res, 400, 'input must be an object')
    if (!run.running(b.id)) return error(res, 409, 'このセッションは返信を処理中ではありません')
    const approval = approvals.ask(b.id, b.tool_name, b.input, typeof b.tool_use_id === 'string' ? b.tool_use_id : '')
    // 自動の「常に許可」（#499）はここから動き出す（Jev に聞く → 届いたら答える）。画面のポーリングを待たない
    void jevAutoTick()
    return json(res, { approval_id: approval.approval_id }, 201)
  }

  /** GET /api/approvals/<approval_id>?wait=1。答えが付いていれば 200 でその決定、まだなら（wait なら最大 WAIT_MS 待って）202 */
  const pollApproval = async (res: ServerResponse, approvalId: string, wait: boolean) => {
    const answer = await approvals.wait(approvalId, wait ? WAIT_MS : 0)
    if (answer === undefined) return error(res, 404, 'approval not found')
    if (answer === null) return json(res, { pending: true }, 202)
    return json(res, answer)
  }

  /** POST /api/approvals/<approval_id>/answer。画面から。同一オリジンのみ（ここが通ると CSRF で許可が押せる） */
  const answerApproval = async (req: IncomingMessage, res: ServerResponse, approvalId: string) => {
    if (isCrossOrigin(req)) return error(res, 403, 'cross-origin request rejected')
    let body: unknown
    try {
      body = await readJson(req, MAX_APPROVAL_BYTES)
    } catch (err) {
      return error(res, 400, err instanceof Error ? err.message : 'bad body')
    }
    const b = (body ?? {}) as Partial<ApprovalAnswer>
    if (b.behavior !== 'allow' && b.behavior !== 'deny') return error(res, 400, 'behavior は allow か deny')
    if (b.remember !== undefined && b.remember !== 'local') return error(res, 400, 'remember は local だけ')
    // 端末で開いている Codex のダイアログ（#450）。押された選択肢まで印を動かして Enter を送る
    if (terminalEnabled && codexDialogs.has?.(approvalId)) {
      if (b.remember !== undefined) return error(res, 400, '端末の Codex では提示された選択だけ選べます')
      const result = await codexDialogs.answer!(approvalId, { behavior: b.behavior, ...(typeof b.decision === 'string' ? { decision: b.decision } : {}) })
      if (!result.ok) return error(res, result.status, result.error)
      noteAnswered(approvalId, b.behavior, typeof b.decision === 'string' ? b.decision : undefined)
      return json(res, { ok: true, approval_id: approvalId, behavior: b.behavior })
    }
    // OpenCode の許可（#421）。提示した選択肢（許可 / 拒否）だけを本体に返す
    if (opencodePerms.has(approvalId)) {
      if (b.remember !== undefined) return error(res, 400, 'OpenCode では提示された選択だけ選べます')
      const result = await opencodePerms.answer(approvalId, { behavior: b.behavior, ...(typeof b.decision === 'string' ? { decision: b.decision } : {}) })
      if (!result.ok) return error(res, result.status, result.error)
      noteAnswered(approvalId, b.behavior, typeof b.decision === 'string' ? b.decision : undefined)
      return json(res, { ok: true, approval_id: approvalId, behavior: b.behavior })
    }
    const codexCurrent = codexApp.getApproval(approvalId)
    if (codexCurrent) {
      if (b.remember !== undefined) return error(res, 400, 'Codexでは提示されたdecisionだけ選べます')
      const answer: ApprovalAnswer = {
        behavior: b.behavior,
        ...(typeof b.decision === 'string' ? { decision: b.decision } : {}),
        ...(b.updatedInput && typeof b.updatedInput === 'object' && !Array.isArray(b.updatedInput) ? { updatedInput: b.updatedInput } : {}),
      }
      const result = codexApp.answer(approvalId, answer)
      if (!result.ok) return error(res, result.status, result.error)
      shownApprovals.set(approvalId, shownApprovals.get(approvalId) ?? codexCurrent)
      noteAnswered(approvalId, answer.behavior, answer.decision)
      return json(res, { ok: true, approval_id: approvalId, behavior: answer.behavior })
    }
    const current = approvals.get(approvalId)
    if (!current) return error(res, 404, 'approval not found')
    const answer: ApprovalAnswer = b.behavior === 'allow'
      ? { behavior: 'allow', updatedInput: b.updatedInput && typeof b.updatedInput === 'object' && !Array.isArray(b.updatedInput) ? b.updatedInput : current.input }
      : { behavior: 'deny', message: typeof b.message === 'string' && b.message.trim() ? b.message.trim() : 'SAI の画面で拒否された' }
    // 「常に許可」のルール。画面から受け取らず、預かっているツール名と入力からサーバが組み立てる（cwd もセッションの行から）
    const cwd = (await store.sessions(90).catch(() => ({ sessions: [] as SessionSummary[] }))).sessions.find((s) => s.id === current.id)?.cwd ?? ''
    const { rules, reason: noRule } = await alwaysPlan(current, cwd)
    if (answer.behavior === 'allow' && b.remember === 'local') {
      if (rules.length === 0) return error(res, 400, 'このツールには「常に許可」は無い')
      answer.updatedPermissions = permissionsFor(rules)
    }
    if (!approvals.answer(approvalId, answer)) return error(res, 409, 'already answered')
    // 回数に足してから返す（次のポーリングの「何回目」がずれない）。鍵は答える前に組んだ組（答えたあとは設定に書かれて空になる）
    const remembered = rulesKey(rules.map(ruleLabel))
    logAnswer(current, cwd, remembered, 'human', answer.behavior, !!answer.updatedPermissions, noRule)
    answered.add(current, answer.behavior, answer.updatedPermissions ? '常に許可' : '')
    return json(res, { ok: true, approval_id: approvalId, behavior: answer.behavior, remembered: answer.updatedPermissions ? remembered : undefined })
  }

  /**
   * PUT /api/sessions/<id>/meta。いまの値に body を重ねる（省略は据え置き、空や null は消す）。
   * アーカイブは archived_at を載せるだけで、専用のエンドポイントは無い。窓の中に無いセッションには付けない
   */
  /**
   * POST /api/sessions/<id>/attachments?name=。body はファイルそのもの（Content-Type も拡張子も見ず、中身で判定。
   * 画像・文字のファイル・PDF。#608）。`name` は元のファイル名で、画面に出す・本文の行に添えるだけ（パスには使わない）。
   * 返した path を返信の `attachments` に入れると、本文の末尾に足されて CLI に渡る
   */
  const postAttachment = async (req: IncomingMessage, res: ServerResponse, id: string, days: number, name = '') => {
    if (isCrossOrigin(req)) return error(res, 403, 'cross-origin request rejected')
    let bytes: Buffer
    try {
      bytes = await readBody(req, ATTACHMENT_MAX_BYTES)
    } catch (err) {
      const big = err instanceof Error && err.message === 'body too large'
      return error(res, big ? 413 : 400, big ? `添付は ${ATTACHMENT_MAX_BYTES / 1024 / 1024}MB までです` : err instanceof Error ? err.message : 'bad body')
    }
    if (bytes.length === 0) return error(res, 400, 'ファイルが空です')
    const { sessions } = await store.sessions(days)
    if (!sessions.some((s) => s.id === id)) return error(res, 404, 'session not found in window')
    const { attachment, error: reason } = await attachmentStore.put(id, bytes, name)
    if (!attachment) return error(res, 400, reason || '保存できませんでした')
    const payload: AttachmentResponse = { id, path: attachment.path, url: attachment.url, mime: attachment.mime, size: attachment.size, kind: attachment.kind, name: attachment.label }
    return json(res, payload)
  }

  /**
   * GET /api/sessions/<id>/permissions。そのセッションの cwd に効いている許可ルールを読んで返す（読むだけ）。
   * パスは cwd から固定で組み立てる（リクエストからは受け取らない）。3 秒のポーリングには乗せない（画面が開いたときだけ）
   */
  const getPermissions = async (res: ServerResponse, id: string, days: number) => {
    const { sessions } = await store.sessions(days)
    const session = sessions.find((s) => s.id === id)
    if (!session) return error(res, 404, 'session not found in window')
    const cwd = session.cwd
    const empty: SessionPermissionsResponse = { id, cwd, agent: session.agent, mode: session.permission_mode, sources: [], rules: [] }
    // 許可の形が Claude Code のものなので、Codex には当てない（Codex は config.toml の approval_policy / trust_level）
    if (session.agent !== 'claude' || !cwd) return json(res, empty)
    const { sources, rules } = await collectPermissions(cwd, { home: homedir() })
    // よく許可しているが、許可のルールに無いもの（#445。出すだけで、足すのはチャットの [常に許可]）
    const frequent = approvalLog.frequent(cwd, rules.filter((r) => r.kind === 'allow').map((r) => r.rule))
    return json(res, { ...empty, sources, rules, ...(frequent.length ? { frequent } : {}) } satisfies SessionPermissionsResponse)
  }

  /**
   * GET /api/sessions/<id>/diff?base=。そのセッションの worktree の差分を git から読む（#171。読むだけ）。
   * cwd はセッションの行から取り、リクエストからは受けない。3 秒のポーリングには乗せない（画面が開いたときだけ）
   */
  /**
   * GET /api/sessions/<id>/diff?summary=1。patch を作らない軽い版（#211）。入力欄の差分ボタンが
   * 「開く前に」行数と PR 番号を出すのに使う。PR は `gh` に任せ、引けなければ付けないだけ
   */
  const getDiffSummary = async (res: ServerResponse, id: string, base: string, days: number) => {
    const { sessions } = await store.sessions(days)
    const session = sessions.find((s) => s.id === id)
    if (!session) return error(res, 404, 'session not found in window')
    let d
    try {
      d = await sessionDiffSummary(git, session.cwd, base)
    } catch (err) {
      if (err instanceof NotAGitRepo) {
        return error(res, 404, `作業ディレクトリで git が読めません（消えた、または git のリポジトリではない）: ${session.cwd || '(空)'}`)
      }
      throw err
    }
    const found = await pr.find(session.cwd, d.head_branch)
    const payload: SessionDiffSummaryResponse = {
      id,
      base: d.base,
      head: d.head,
      files: d.files,
      added: d.added,
      removed: d.removed,
      branch: d.branch,
      working: d.working,
      untracked: d.untracked,
      ...(found ? { pr: found } : {}),
    }
    return json(res, payload)
  }

  /**
   * GET /api/sessions/<id>/turn?ts=（#537）。そのセッションの、`ts` のターン完了の行。`ts` が無ければ一番新しいもの。
   * 要対応の「終了」の行で一言（要約）のもとの本文を開くためで、**押したときに 1 回だけ**取る（一覧のポーリングには載せない）。
   * 一言は `(id, last_turn_ts)` で引いているので、同じ `ts` を渡せば同じ行が返る（新しいターンが届いていても取り違えない）。
   * 同じ秒に 2 本あれば、あとに書かれた方（`aggregate.ts` の `last_turn_ts` と同じ）
   */
  /**
   * GET /api/sessions/<id>/turn-steps?ts=（#605）。`ts` のターン完了の行のターンで呼んだツール（コマンド・ファイル名まで。出力は出さない）。
   * **バブルの「手順」を開いたときに 1 回だけ**取る（transcript / rollout を頭から読むので、ポーリングには乗せない）。
   * ターンは行から引き当てる: 前のターン完了の行より後の、いちばん古い入力の行の時刻（始まり）から `ts`（終わり）まで。入力の行が無ければ終わりだけ。
   * 引けない・別のマシン・OpenCode は `found: false`（画面は「記録がありません」）。パスはリクエストから受けない
   */
  const getTurnSteps = async (res: ServerResponse, id: string, ts: string, days: number) => {
    if (!ts) return error(res, 400, 'ts が要ります')
    const { sessions } = await store.sessions(days)
    const session = sessions.find((s) => s.id === id)
    if (!session) return error(res, 404, 'session not found in window')
    const none: TurnStepsResponse = { id, ts, found: false, steps: [], total: 0 }
    const rows = await rowsNow(days)
    // 同じ秒に 2 本あれば、あとに書かれた方（`getTurn` と同じ）
    let at = -1
    for (let i = rows.length - 1; i >= 0 && at < 0; i--) {
      const r = rows[i]!
      if (r.ts === ts && eventKind(r.event, r.text) === 'turn' && entityId(r.session ?? '', r.repo ?? '', String(r.ts ?? '')) === id) at = i
    }
    const row = rows[at]
    if (!row || isRemoteHost(row.host ?? '', selfHost())) return json(res, none)
    const turns = await progress.turnSteps({ id, repo: session.repo, agent: row.agent ?? session.agent, cwd: row.cwd || session.cwd })
    if (!turns) return json(res, none)
    // 前のターン完了の行まで遡り、その間の入力の行を古い順に渡す（#663 のレビュー。途中で足した入力 = steer の行を
    // 始まりにすると、足す前の手順が落ちる）。どれを始まりにするか・Esc で止めた跡で切るのは `findStepTurn()`
    const starts: { ms: number; input: string }[] = []
    for (let i = at - 1; i >= 0; i--) {
      const r = rows[i]!
      if (r.session !== row.session) continue
      const kind = eventKind(r.event, r.text)
      if (kind === 'turn') break
      if (kind === 'resume' && r.user_text?.trim()) starts.unshift({ ms: rowMs(r.ts), input: r.user_text })
    }
    const turn = findStepTurn(turns, { starts, endMs: rowMs(row.ts) })
    if (!turn) return json(res, none)
    // 数えるのはツールの呼び出しだけ（途中の文は数に入れない。#680）
    const more = Math.max(0, turn.steps.length - TURN_STEPS_MAX)
    const payload: TurnStepsResponse = { id, ts, found: true, steps: turn.steps.slice(0, TURN_STEPS_MAX), total: turn.steps.filter((s) => s.text === undefined).length, ...(more > 0 ? { more } : {}) }
    return json(res, payload)
  }

  const getTurn = async (res: ServerResponse, id: string, ts: string, days: number) => {
    const { sessions } = await store.sessions(days)
    if (!sessions.some((s) => s.id === id)) return error(res, 404, 'session not found in window')
    const turns = (await rowsNow(days)).filter((r) => eventKind(r.event, r.text) === 'turn' && entityId(r.session ?? '', r.repo ?? '', String(r.ts ?? '')) === id)
    const hits = ts ? turns.filter((r) => r.ts === ts) : turns
    const payload: SessionTurnResponse = { id, row: hits.at(-1) ?? null }
    return json(res, payload)
  }

  /**
   * GET /api/sessions/<id>/progress（#302）。処理中のターンがいま何をしているか。transcript / rollout の末尾を読むだけ。
   * パスは行の cwd とセッション ID から組み立てる（リクエストからは受けない）。3 秒のポーリングには乗せない
   * （画面が処理中のセッションを出している間だけ、そのセッションの分を取る）。
   * 別のマシンのセッションは transcript がこちらに無いので読まない（同じ ID のファイルがあっても別物）
   */
  const getProgress = async (res: ServerResponse, id: string, days: number) => {
    const { sessions } = await store.sessions(days)
    const session = sessions.find((s) => s.id === id)
    if (!session) return error(res, 404, 'session not found in window')
    if (isRemoteHost(session.host, selfHost())) {
      const payload: SessionProgressResponse = { rev: '', id, active: false, steps: [], total: 0, updated_at: '', context_tokens: 0 }
      return json(res, payload)
    }
    const parsed = await progress.read(session)
    // エージェント自身の段取り（#397。OpenCode だけ）。transcript は読めないが、本体が持っている
    // （**すでに立っているサーバにだけ聞く**ので、段取りのために `opencode serve` は起こさない）
    if (session.agent === 'opencode') return json(res, await withTodos(parsed, session))
    // transcript は**端末で Esc を押して止めたターンを閉じないまま残す**（#302 の実測で 536 件中 13 件）ので、
    // CLI 側の実測で打ち消す（#418）。**`busy` が false と分かったときだけ**落とし、
    // 聞けなかった（`undefined`）ときは今までどおり transcript の判定を使う
    if (!parsed.active || session.agent !== 'claude') return json(res, parsed)
    const busy = await claudeAgents.busy(sessionOf(session))
    if (busy !== false) return json(res, parsed)
    // rev も変えておく（画面は rev が同じなら描き直さない）
    const stopped: SessionProgressResponse = { ...parsed, active: false, rev: `${parsed.rev}|idle` }
    return json(res, stopped)
  }

  /**
   * `claude --bg` のセッションの短い ID と状態（#462）。このマシンの Claude だけ。聞けなければ（`claude` が無い・古い）出さない
   */
  const backgroundOf = async (session: SessionSummary): Promise<BackgroundSession | undefined> => {
    if (session.agent !== 'claude' || !claudeAgents.background || isRemoteHost(session.host, selfHost())) return undefined
    const raw = sessionOf(session)
    if (!raw) return undefined
    // 画面の道なので、前に引いた一覧があれば待たずにそれで返す（#592。`claude agents` の TTL はポーリングと同じ 3 秒で、
    // 待ち切るとポーリングのたびに子が終わるまで詳細が止まる。引き直しは裏で続き、状態が変われば rev で次に拾う）。
    // 返信の直前（`launch()`）は今までどおり引き直して待つ
    const seen = claudeAgents.peekBackground?.(raw)
    const bg = await screenWait(claudeAgents.background(raw), () => seen, seen !== undefined)
    if (!bg || !bg.id) return undefined
    return { attach: bg.id, live: backgroundLive(bg), status: bg.state || bg.status }
  }

  /**
   * OpenCode の段取りとサブセッションの数を足す（#397）。**空なら何も足さない**（キーごと省く）。
   * 中身は `rev` にも混ぜる（同じ rev だと画面が描き直さないので、段取りが進んでも出ない）。
   * 聞けなければ（サーバが立っていない・落ちた）今までどおりそのまま返す
   */
  const withTodos = async (parsed: SessionProgressResponse, session: SessionSummary): Promise<SessionProgressResponse> => {
    const raw = sessionOf(session)
    if (!raw) return parsed
    let got: { todos: SessionTodo[]; children: number }
    try {
      got = await opencodeApp.todos(raw)
    } catch {
      return parsed
    }
    if (got.todos.length === 0 && got.children === 0) return parsed
    return {
      ...parsed,
      rev: `${parsed.rev}|${got.todos.map((t) => t.status).join('')}:${got.todos.length}:${got.children}`,
      ...(got.todos.length > 0 ? { todos: got.todos } : {}),
      ...(got.children > 0 ? { children: got.children } : {}),
    }
  }

  const getDiff = async (res: ServerResponse, id: string, base: string, days: number) => {
    const { sessions } = await store.sessions(days)
    const session = sessions.find((s) => s.id === id)
    if (!session) return error(res, 404, 'session not found in window')
    let d
    try {
      d = await sessionDiff(git, session.cwd, base)
    } catch (err) {
      if (err instanceof NotAGitRepo) {
        return error(res, 404, `作業ディレクトリで git が読めません（消えた、または git のリポジトリではない）: ${session.cwd || '(空)'}`)
      }
      throw err
    }
    const payload: SessionDiffResponse = {
      id,
      cwd: session.cwd,
      base: d.base,
      head: d.head,
      session_branch: session.branch,
      compare_url: compareUrl(session.remote, d.base, d.head),
      branch: d.branch,
      working: d.working,
      untracked: d.untracked,
    }
    return json(res, payload)
  }

  const putMeta = async (req: IncomingMessage, res: ServerResponse, id: string, days: number) => {
    if (isCrossOrigin(req)) return error(res, 403, 'cross-origin request rejected')
    let body: unknown
    try {
      body = await readJson(req, MAX_META_BYTES)
    } catch (err) {
      return error(res, 400, err instanceof Error ? err.message : 'bad body')
    }
    const { meta, error: reason } = mergeMeta((await metaStore.get(id)) ?? {}, body)
    if (reason) return error(res, 400, reason)
    const { sessions } = await store.sessions(days)
    if (!sessions.some((s) => s.id === id)) return error(res, 404, 'session not found in window')
    const saved = await metaStore.set(id, meta)
    const payload: SessionMetaResponse = { id, meta: saved ?? {} }
    return json(res, payload)
  }

  /**
   * PUT /api/sessions/<id>/read（#502）。そのターン完了まで読んだ印を置く。前にしか進めず、`back` のときだけ
   * その発言の直前まで戻す（「ここから未読にする」）。同一オリジンのみ（別サイトから未読を消させない）
   */
  const putRead = async (req: IncomingMessage, res: ServerResponse, id: string, days: number) => {
    if (isCrossOrigin(req)) return error(res, 403, 'cross-origin request rejected')
    let body: unknown
    try {
      body = await readJson(req, MAX_META_BYTES)
    } catch (err) {
      return error(res, 400, err instanceof Error ? err.message : 'bad body')
    }
    const { ts, back } = (body ?? {}) as Partial<ReadRequest>
    if (typeof ts !== 'string' || !Number.isFinite(rowMs(ts))) return error(res, 400, 'ts が要ります')
    const { sessions } = await store.sessions(days)
    if (!sessions.some((s) => s.id === id)) return error(res, 404, 'session not found in window')
    const readAt = await readStore.mark(id, back === true ? unreadFromMark(ts) : rowMs(ts), back === true)
    const payload: ReadResponse = { id, read_at: readAt }
    return json(res, payload)
  }

  /**
   * POST /api/sessions/<id>/suggestion（#565）。Manager が置いた案を捨てる（`discard`）・入力欄に入れた（`accept`）。
   * どちらも案を取り除き、reply.log に 1 行残す。**送りはしない**（入れた本文を送るのは今までどおり人の返信）。同一オリジンのみ
   */
  const postSuggestion = async (req: IncomingMessage, res: ServerResponse, id: string) => {
    if (isCrossOrigin(req)) return error(res, 403, 'cross-origin request rejected')
    let body: unknown
    try {
      body = await readJson(req, MAX_META_BYTES)
    } catch (err) {
      return error(res, 400, err instanceof Error ? err.message : 'bad body')
    }
    const { action, at } = (body ?? {}) as Partial<SuggestionActionRequest>
    if (action !== 'accept' && action !== 'discard') return error(res, 400, 'action は accept か discard です')
    if (typeof at !== 'number' || !Number.isFinite(at)) return error(res, 400, 'at が要ります')
    const taken = await suggestionStore.take(id, at)
    if (taken) {
      await appendFile(join(store.directory, 'reply.log'), `--- ${new Date().toISOString()} ${id} Manager の案（mcp:${taken.from}）を${action === 'accept' ? '入力欄に入れた' : '捨てた'}\n`).catch(() => {})
    }
    const payload: SuggestionActionResponse = { id, taken: Boolean(taken) }
    return json(res, payload)
  }

  /** GET /api/sessions/<id>/icon。?v= がいまのファイルと同じなら長くキャッシュさせる（差し替えれば URL が変わる） */
  const getIcon = async (req: IncomingMessage, res: ServerResponse, id: string, version: string | null) => {
    const icon = await iconStore.get(id)
    if (!icon) return error(res, 404, 'icon not found')
    let body: Buffer
    try {
      body = await readFile(icon.path)
    } catch {
      return error(res, 404, 'icon not found')
    }
    res.writeHead(200, {
      'Content-Type': icon.mime,
      'Content-Length': body.length,
      'Cache-Control': version === icon.version ? 'private, max-age=31536000, immutable' : 'no-store',
    })
    res.end(req.method === 'HEAD' ? undefined : body)
  }

  /**
   * PUT /api/sessions/<id>/icon。body は画像そのもの。中身で種類を見て、画像でなければ 400。
   * DELETE で消す。どちらも別オリジンは 403、窓の中に無いセッションは 404（表示名と同じ）
   */
  /** 画像の body を読む。大きすぎれば 413、空なら 400。失敗したら応答を書いて null */
  const readIconBody = async (req: IncomingMessage, res: ServerResponse): Promise<Buffer | null> => {
    let bytes: Buffer
    try {
      bytes = await readBody(req, ICON_MAX_BYTES)
    } catch (err) {
      const big = err instanceof Error && err.message === 'body too large'
      error(res, big ? 413 : 400, big ? `画像は ${ICON_MAX_BYTES / 1024 / 1024}MB までです` : (err instanceof Error ? err.message : 'bad body'))
      return null
    }
    if (bytes.length === 0) {
      error(res, 400, '画像が空です')
      return null
    }
    return bytes
  }
  /**
   * 置く画像。`?history=<key>` なら履歴の画像（#465。**サーバが自分の置き場から読む**。パスは受けない）、無ければ body。
   * 失敗したら応答を書いて null
   */
  const iconBytes = async (req: IncomingMessage, res: ServerResponse, history: string | null): Promise<Uint8Array | null> => {
    if (history === null) return await readIconBody(req, res)
    const bytes = isHistoryKey(history) ? await iconHistory.read(history) : null
    if (!bytes) {
      error(res, 404, '履歴にその画像がありません')
      return null
    }
    return bytes
  }
  /** 置けた画像を履歴にも入れる（#465）。入れられなくてもアイコンは置けているので、失敗は黙る */
  const rememberIcon = (bytes: Uint8Array) => iconHistory.add(bytes).catch(() => '')
  const putIcon = async (req: IncomingMessage, res: ServerResponse, id: string, days: number, history: string | null) => {
    if (isCrossOrigin(req)) return error(res, 403, 'cross-origin request rejected')
    const bytes = await iconBytes(req, res, history)
    if (!bytes) return
    const { sessions } = await store.sessions(days)
    if (!sessions.some((s) => s.id === id)) return error(res, 404, 'session not found in window')
    const { icon, error: reason } = await iconStore.put(id, bytes)
    if (reason || !icon) return error(res, 400, reason || '保存できませんでした')
    await rememberIcon(bytes)
    const payload: SessionIconResponse = { id, icon: iconUrl(id, icon.version) }
    return json(res, payload)
  }
  /** PUT /api/profile。body { name? } をいまの値に重ねる（空は消す）。GET は profileNow をそのまま */
  const putProfile = async (req: IncomingMessage, res: ServerResponse) => {
    if (isCrossOrigin(req)) return error(res, 403, 'cross-origin request rejected')
    let body: unknown
    try {
      body = await readJson(req, MAX_META_BYTES)
    } catch (err) {
      return error(res, 400, err instanceof Error ? err.message : 'bad body')
    }
    const { name, error: reason } = mergeProfile({ name: (await profileStore.get()).name }, body)
    if (reason) return error(res, 400, reason)
    await profileStore.set(name)
    const payload: ProfileResponse = { profile: (await profileNow()).profile }
    return json(res, payload)
  }
  /** PUT / DELETE /api/profile/icon。セッションのアイコンと同じ IconStore に固定の鍵で置く（窓の検査は無い） */
  const putProfileIcon = async (req: IncomingMessage, res: ServerResponse, history: string | null) => {
    if (isCrossOrigin(req)) return error(res, 403, 'cross-origin request rejected')
    const bytes = await iconBytes(req, res, history)
    if (!bytes) return
    const { icon, error: reason } = await iconStore.put(PROFILE_ICON_ID, bytes)
    if (reason || !icon) return error(res, 400, reason || '保存できませんでした')
    await rememberIcon(bytes)
    const payload: ProfileResponse = { profile: (await profileNow()).profile }
    return json(res, payload)
  }
  const deleteProfileIcon = async (req: IncomingMessage, res: ServerResponse) => {
    if (isCrossOrigin(req)) return error(res, 403, 'cross-origin request rejected')
    await iconStore.remove(PROFILE_ICON_ID)
    const payload: ProfileResponse = { profile: (await profileNow()).profile }
    return json(res, payload)
  }
  /**
   * GET /api/icon-history（#465）。新しく使った順。`?id=` / `?profile=1` なら、いまのアイコンと同じ画像の鍵を `current` に。
   * 中身の sha1 で比べる（いまのアイコンは session-icons/ に別のコピーとして置いてあるので、ファイル名では分からない）
   */
  const getIconHistory = async (res: ServerResponse, q: URLSearchParams) => {
    const entries = await iconHistory.list()
    const payload: IconHistoryResponse = { items: entries.map((e) => ({ key: e.key, url: historyIconUrl(e.key, e.version), used_at: e.used_at })) }
    const target = q.get('profile') === '1' ? PROFILE_ICON_ID : q.get('id')
    const icon = target ? await iconStore.get(target) : undefined
    if (icon) {
      try {
        const key = historyKey(await readFile(icon.path))
        if (entries.some((e) => e.key === key)) payload.current = key
      } catch {
        // 読めなければ印を付けないだけ
      }
    }
    return json(res, payload)
  }
  /** GET /api/icon-history/<key>。中身で名前が決まるので、?v= が合っていれば長くキャッシュさせる */
  const getHistoryIcon = async (req: IncomingMessage, res: ServerResponse, key: string, version: string | null) => {
    const entry = await iconHistory.get(key)
    const body = entry ? await iconHistory.read(key) : null
    if (!entry || !body) return error(res, 404, 'icon not found')
    res.writeHead(200, {
      'Content-Type': entry.mime,
      'Content-Length': body.length,
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': version === entry.version ? 'private, max-age=31536000, immutable' : 'no-store',
    })
    res.end(req.method === 'HEAD' ? undefined : Buffer.from(body))
  }
  /** DELETE /api/icon-history/<key>。履歴から消すだけで、いま使っているセッションのアイコンは残る */
  const deleteHistoryIcon = async (req: IncomingMessage, res: ServerResponse, key: string) => {
    if (isCrossOrigin(req)) return error(res, 403, 'cross-origin request rejected')
    if (!(await iconHistory.remove(key))) return error(res, 404, 'icon not found')
    const payload: IconHistoryResponse = { items: (await iconHistory.list()).map((e) => ({ key: e.key, url: historyIconUrl(e.key, e.version), used_at: e.used_at })) }
    return json(res, payload)
  }
  const deleteIcon = async (req: IncomingMessage, res: ServerResponse, id: string) => {
    if (isCrossOrigin(req)) return error(res, 403, 'cross-origin request rejected')
    await iconStore.remove(id)
    const payload: SessionIconResponse = { id, icon: null }
    return json(res, payload)
  }

  /**
   * いま配っているビルドの識別子（dist/index.html の mtime）。未ビルドなら空。
   * Vite のアセット名はハッシュ入りなので、JS が変われば index.html も必ず変わる。
   */
  const buildId = async (): Promise<string> => {
    try {
      return String((await stat(resolve(distRoot, 'index.html'))).mtimeMs)
    } catch {
      return ''
    }
  }

  /**
   * SAI が起こした長寿命の子を終わらせる（#457）。`main.ts` の `shutdown()` が呼ぶ。
   *
   * 落とすのは **`opencode serve`** だけ。実測（2026-09-25）: SAI に SIGTERM を送ると、`opencode serve` は
   * **ppid 1 の孤児になって走り続ける**（保留中の許可もその中に残り、#422 の「答える相手が消えた待ち」を作る）。
   * **`codex app-server --stdio` は自分で終わる**（親が死ぬと stdin のパイプが閉じるため。同じ実測で消えていた）ので触らない。
   * **返信の子（`claude -p` など）は巻き込まない**（別の pgid で detached。次のサーバが `replying.json` から引き取る。#296）
   */
  const dispose = (): void => {
    // ログインの子（#577）は残さない（残ると、人が居ないままコードを待ち続ける）
    claudeLogin.stop()
    opencodeApp.stop()
    if (loopTimer) clearInterval(loopTimer)
    if (waitTimer) clearInterval(waitTimer)
  }

  const handler = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    // 全リクエストに先に掛ける。tailnet 経由（Serve のヘッダ付き）は whois で本人を確かめ、合わなければ 401。
    // ヘッダ無しはループバックからの直アクセスだけ通す
    let who: Identity | null
    try {
      who = await auth.identify(req)
    } catch (err) {
      return error(res, 500, err instanceof Error ? `${err.name}: ${err.message}` : String(err))
    }
    if (!who) return error(res, 401, 'unauthorized: Tailscale-User-Login が whois と一致しない')
    // 接続元アドレスだけでは DNS rebinding を見分けられない。Serve 経由は whois で確かめるので Host は MagicDNS 名のまま通す
    if (who.kind === 'local' && !isLoopbackHostHeader(req.headers.host)) return error(res, 403, 'ローカルから使うときは Host が 127.0.0.1 / localhost / [::1] でなければなりません')
    const viewer = viewerOf(who)
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    const q = url.searchParams
    const path = url.pathname
    const isReply = path.startsWith(SESSIONS_PREFIX) && path.endsWith(REPLY_SUFFIX)
    const isReview = path.startsWith(SESSIONS_PREFIX) && path.endsWith(REVIEW_SUFFIX)
    const isFork = path.startsWith(SESSIONS_PREFIX) && path.endsWith(FORK_SUFFIX)
    const isMeta = path.startsWith(SESSIONS_PREFIX) && path.endsWith(META_SUFFIX)
    const isRead = path.startsWith(SESSIONS_PREFIX) && path.endsWith(READ_SUFFIX)
    const isSuggestion = path.startsWith(SESSIONS_PREFIX) && path.endsWith(SUGGESTION_SUFFIX)
    const isIcon = path.startsWith(SESSIONS_PREFIX) && path.endsWith(ICON_SUFFIX)
    const isSkills = path.startsWith(SESSIONS_PREFIX) && path.endsWith(SKILLS_SUFFIX)
    const isModels = path.startsWith(SESSIONS_PREFIX) && path.endsWith(MODELS_SUFFIX)
    const isPermissions = path.startsWith(SESSIONS_PREFIX) && path.endsWith(PERMISSIONS_SUFFIX)
    const isDiff = path.startsWith(SESSIONS_PREFIX) && path.endsWith(DIFF_SUFFIX)
    const isProgress = path.startsWith(SESSIONS_PREFIX) && path.endsWith(PROGRESS_SUFFIX)
    const isAttachUpload = path.startsWith(SESSIONS_PREFIX) && path.endsWith(ATTACHMENTS_SUFFIX)
    const isAttachFile = path.startsWith(ATTACHMENTS_PREFIX)
    // `/api/sessions/<id>/queue/<queue_id | resume>`。id は `/` を含まないので、最初の `/queue/` が区切り（#305）
    const queueAt = path.startsWith(SESSIONS_PREFIX) ? path.indexOf(QUEUE_SEGMENT, SESSIONS_PREFIX.length) : -1
    const isQueue = queueAt > 0
    // エージェント用の口（#310）。トークンを要り、ブラウザからは通さない
    const isAgent = path.startsWith(AGENT_PREFIX)
    // 人が画面から送信を止める・再開する口（#311）。画面から叩くので、エージェント用の口とは別に同一オリジンで受ける
    const isAgentStop = path.startsWith(SESSIONS_PREFIX) && (path.endsWith(AGENT_STOP_SUFFIX) || path.endsWith(AGENT_RESUME_SUFFIX))
    // 処理中のターンを止める（#384）。画面から叩くので同一オリジンで受ける
    const isInterrupt = path.startsWith(SESSIONS_PREFIX) && path.endsWith(INTERRUPT_SUFFIX)
    // ループを組む・止める・再開・いま起こす・片付ける（#634）。画面から叩くので同一オリジンで受ける
    const loopSuffix = path.startsWith(SESSIONS_PREFIX) ? LOOP_SUFFIXES.find((sfx) => path.endsWith(sfx)) : undefined
    // 待ちを止める・いま起こす（#732）。画面から叩くので同一オリジンで受ける
    const waitSuffix = path.startsWith(SESSIONS_PREFIX) ? WAIT_SUFFIXES.find((sfx) => path.endsWith(sfx)) : undefined
    const isAsk = path === APPROVALS_PATH
    const isAnswer = path.startsWith(APPROVALS_PREFIX) && path.endsWith(ANSWER_SUFFIX)
    const isProfile = path === PROFILE_PATH
    const isProfileIcon = path === PROFILE_ICON_PATH
    const isHistoryIcon = path.startsWith(`${ICON_HISTORY_PATH}/`)
    const isSettings = path === SETTINGS_PATH
    const isAuthCheck = path === CLAUDE_AUTH_CHECK_PATH
    const isAuthLogin = path === CLAUDE_LOGIN_PATH
    const isDigestFeedback = path === DIGEST_FEEDBACK_PATH
    const isNewSession = path === NEW_SESSION_PATH
    // GitHub へのレビューの投稿（#526）。SAI が GitHub に書く唯一の口
    const isPrReview = path.startsWith(`${PRS_PATH}/`) && path.endsWith(PR_REVIEW_SUFFIX)
    const method = req.method ?? 'GET'
    // tailnet から MCP で呼ぶ口（#312）。POST / OPTIONS（CORS）を受けるので、下の書き込みの判定より先に分ける
    if (path === MCP_PATH) {
      try {
        return await mcpHttp(req, res, who, method)
      } catch (err) {
        return error(res, 500, err instanceof Error ? `${err.name}: ${err.message}` : String(err))
      }
    }
    // タグ付きの端末（ユーザーがいない）は画面・REST を使えない。capability を与えた /mcp だけ
    if (who.kind === 'tagged') return error(res, 401, 'unauthorized: タグ付きの端末から使えるのは /mcp だけです')
    // 書き込みは「返信と新しいセッションと PR のレビューの投稿（#526）は POST」「表示名は PUT」「アイコンは PUT / DELETE」「承認の預かりと答えは POST」「Manager の案を捨てる・入れた（#565）は POST」「自分の表示名は PUT、アイコンは PUT / DELETE」
    // 「設定は PUT」「預かった返信の再開は POST、取り消しは DELETE」だけ。それ以外は GET / HEAD のみ
    const writable =
      (method === 'POST' &&
        (isNewSession || isAuthCheck || isAuthLogin || isReply || isReview || isFork || isPrReview || isAsk || isAnswer || isAttachUpload || isQueue || isDigestFeedback || isSuggestion || path === AGENT_SEND_PATH || path === AGENT_LOOP_PATH || path === AGENT_WAIT_FOR_PATH || isAgentStop || isInterrupt || loopSuffix !== undefined || waitSuffix !== undefined)) ||
      (method === 'DELETE' && (isQueue || isHistoryIcon || loopSuffix === '/loop')) ||
      (method === 'PUT' && (isMeta || isRead || isProfile || isSettings)) ||
      ((method === 'PUT' || method === 'DELETE') && (isIcon || isProfileIcon))
    if (!writable && method !== 'GET' && method !== 'HEAD') return error(res, 405, 'method not allowed')
    try {
      if (isInterrupt) {
        if (method !== 'POST') return error(res, 405, 'method not allowed')
        const id = sessionIdFrom(path, INTERRUPT_SUFFIX)
        if (id === null) return error(res, 400, 'bad session id')
        return await interrupt(req, res, id)
      }
      if (isAgentStop) {
        if (method !== 'POST') return error(res, 405, 'method not allowed')
        const stop = path.endsWith(AGENT_STOP_SUFFIX)
        const id = sessionIdFrom(path, stop ? AGENT_STOP_SUFFIX : AGENT_RESUME_SUFFIX)
        if (id === null) return error(res, 400, 'bad session id')
        return await agentStop(req, res, id, stop)
      }
      if (loopSuffix !== undefined) {
        const id = sessionIdFrom(path, loopSuffix)
        if (id === null) return error(res, 400, 'bad session id')
        return await loopAction(req, res, id, loopSuffix)
      }
      if (waitSuffix !== undefined) {
        const id = sessionIdFrom(path, waitSuffix)
        if (id === null) return error(res, 400, 'bad session id')
        return await waitAction(req, res, id, waitSuffix)
      }
      if (isAgent) {
        if (path === AGENT_LOOP_PATH) {
          if (method !== 'POST') return error(res, 405, 'method not allowed')
          return await agentLoopNext(req, res)
        }
        if (path === AGENT_WAIT_FOR_PATH) {
          if (method !== 'POST') return error(res, 405, 'method not allowed')
          return await agentWaitFor(req, res)
        }
        if (path === AGENT_SEND_PATH) {
          if (method !== 'POST') return error(res, 405, 'method not allowed')
          return await agentSend(req, res)
        }
        if (method !== 'GET') return error(res, 405, 'method not allowed')
        if (path === AGENT_SESSIONS_PATH) return await agentSessions(req, res, q)
        if (path === AGENT_WAIT_PATH) return await agentWait(req, res, q)
        return error(res, 404, 'not found')
      }
      // 返信（`/reply`）などの判定より先に見る（queue_id が `reply` のような文字列でも取り違えない）
      if (isQueue) {
        const id = sessionIdFrom(path, path.slice(queueAt))
        if (id === null) return error(res, 400, 'bad session id')
        return await queueAction(req, res, id, path.slice(queueAt + QUEUE_SEGMENT.length))
      }
      // `/api/sessions/<id>`（詳細）より先に見る
      if (isNewSession) {
        if (method !== 'POST') return error(res, 405, 'method not allowed')
        return await startSession(req, res, parseDays(q.get('days'), 90))
      }
      if (isReply) {
        if (method !== 'POST') return error(res, 405, 'method not allowed')
        const id = sessionIdFrom(path, REPLY_SUFFIX)
        if (id === null) return error(res, 400, 'bad session id')
        return await reply(req, res, id, parseDays(q.get('days'), 90))
      }
      if (isReview) {
        if (method !== 'POST') return error(res, 405, 'method not allowed')
        const id = sessionIdFrom(path, REVIEW_SUFFIX)
        if (id === null) return error(res, 400, 'bad session id')
        return await review(req, res, id, parseDays(q.get('days'), 90))
      }
      if (isFork) {
        if (method !== 'POST') return error(res, 405, 'method not allowed')
        const id = sessionIdFrom(path, FORK_SUFFIX)
        if (id === null) return error(res, 400, 'bad session id')
        return await fork(req, res, id, parseDays(q.get('days'), 90))
      }
      if (isAsk) {
        if (method !== 'POST') return error(res, 405, 'method not allowed')
        return await askApproval(req, res)
      }
      if (isAnswer) {
        if (method !== 'POST') return error(res, 405, 'method not allowed')
        return await answerApproval(req, res, path.slice(APPROVALS_PREFIX.length, -ANSWER_SUFFIX.length))
      }
      if (path.startsWith(APPROVALS_PREFIX)) {
        return await pollApproval(res, path.slice(APPROVALS_PREFIX.length), q.get('wait') === '1')
      }
      if (path.startsWith('/api/')) {
        // 画面はポーリングのついでにこれを見て、別ターミナルで pnpm build されたらリロードする
        const build = await buildId()
        if (build) res.setHeader('X-SAI-Build', build)
      }
      if (isSuggestion && !isQueue) {
        if (method !== 'POST') return error(res, 405, 'method not allowed')
        const id = sessionIdFrom(path, SUGGESTION_SUFFIX)
        if (id === null) return error(res, 400, 'bad session id')
        return await postSuggestion(req, res, id)
      }
      if (isRead && !isQueue) {
        if (method !== 'PUT') return error(res, 405, 'method not allowed')
        const id = sessionIdFrom(path, READ_SUFFIX)
        if (id === null) return error(res, 400, 'bad session id')
        return await putRead(req, res, id, parseDays(q.get('days'), 90))
      }
      if (isMeta) {
        const id = sessionIdFrom(path, META_SUFFIX)
        if (id === null) return error(res, 400, 'bad session id')
        if (method === 'PUT') return await putMeta(req, res, id, parseDays(q.get('days'), 90))
        const payload: SessionMetaResponse = { id, meta: (await metaStore.get(id)) ?? {} }
        return json(res, payload)
      }
      if (isSkills) {
        const id = sessionIdFrom(path, SKILLS_SUFFIX)
        if (id === null) return error(res, 400, 'bad session id')
        const { sessions } = await store.sessions(parseDays(q.get('days'), 90))
        const session = sessions.find((s) => s.id === id)
        if (!session) return error(res, 404, 'session not found in window')
        const payload: SessionSkillsResponse = { id, skills: await sessionSkills(session) }
        return json(res, payload)
      }
      // 返信で選べるモデル（#394）。いまは OpenCode だけ本体に聞く（Claude / Codex は記録から組み立てるまま）。
      // メニューを開いたときだけ取りに来るので、3 秒のポーリングには乗らない
      if (isModels) {
        const id = sessionIdFrom(path, MODELS_SUFFIX)
        if (id === null) return error(res, 400, 'bad session id')
        const { sessions } = await store.sessions(parseDays(q.get('days'), 90))
        const session = sessions.find((s) => s.id === id)
        if (!session) return error(res, 404, 'session not found in window')
        const models = session.agent === 'opencode' && opencodeServerEnabled ? await opencodeApp.models(session.cwd).catch(() => []) : []
        const payload: SessionModelsResponse = { id, models }
        return json(res, payload)
      }
      if (isIcon) {
        const id = sessionIdFrom(path, ICON_SUFFIX)
        if (id === null) return error(res, 400, 'bad session id')
        if (method === 'PUT') return await putIcon(req, res, id, parseDays(q.get('days'), 90), q.get('history'))
        if (method === 'DELETE') return await deleteIcon(req, res, id)
        return await getIcon(req, res, id, q.get('v'))
      }
      if (isDiff) {
        const id = sessionIdFrom(path, DIFF_SUFFIX)
        if (id === null) return error(res, 400, 'bad session id')
        const base = q.get('base') ?? ''
        const days = parseDays(q.get('days'), 90)
        // summary=1 は行数と PR 番号だけ（本文を作らない。#211）
        return q.get('summary') === '1' ? await getDiffSummary(res, id, base, days) : await getDiff(res, id, base, days)
      }
      if (isAttachUpload) {
        const id = sessionIdFrom(path, ATTACHMENTS_SUFFIX)
        if (id === null) return error(res, 400, 'bad session id')
        return await postAttachment(req, res, id, parseDays(q.get('days'), 90), q.get('name') ?? '')
      }
      if (isAttachFile) {
        const [dir = '', name = '', ...rest] = path.slice(ATTACHMENTS_PREFIX.length).split('/')
        const found = rest.length > 0 ? null : await attachmentStore.find(dir, name)
        if (!found) return error(res, 404, 'attachment not found')
        let body: Buffer
        try {
          body = await readFile(found.path)
        } catch {
          return error(res, 404, 'attachment not found')
        }
        // 軽い版（#589）。添付は画像だけ受けているが、種類は中身で見る
        const type = q.get('thumb') === '1' ? sniffImageType(body) : null
        const t = type ? await thumbs.thumb({ bytes: body, type }) : ({ kind: 'original' } as const)
        if (t.kind === 'unavailable') {
          res.writeHead(503, { 'Cache-Control': 'no-store', 'X-SAI-Thumb': 'unavailable', 'X-SAI-Image-Bytes': body.length, 'Content-Length': 0 })
          res.end()
          return
        }
        const out = t.kind === 'thumb' ? { bytes: t.bytes, mime: ICON_MIME[t.type] } : { bytes: body, mime: found.mime }
        // 名前が中身のハッシュなので、同じ URL の中身は変わらない
        res.writeHead(200, { 'Content-Type': out.mime, 'Content-Length': out.bytes.length, 'Cache-Control': 'private, max-age=31536000, immutable' })
        res.end(req.method === 'HEAD' ? undefined : out.bytes)
        return
      }
      // セッションに出てきた画像の一覧と、Claude の transcript の画像（#504）。どちらもパスはリクエストから受けない
      const transcriptAt = path.startsWith(SESSIONS_PREFIX) ? path.indexOf(TRANSCRIPT_IMAGES_SEGMENT, SESSIONS_PREFIX.length) : -1
      const codexImagesAt = path.startsWith(SESSIONS_PREFIX) ? path.indexOf(CODEX_IMAGES_SEGMENT, SESSIONS_PREFIX.length) : -1
      if (path.startsWith(SESSIONS_PREFIX) && (path.endsWith(GALLERY_SUFFIX) || transcriptAt > 0 || codexImagesAt > 0)) {
        const id = transcriptAt > 0 ? sessionIdFrom(path, path.slice(transcriptAt)) : codexImagesAt > 0 ? sessionIdFrom(path, path.slice(codexImagesAt)) : sessionIdFrom(path, GALLERY_SUFFIX)
        if (id === null) return error(res, 400, 'bad session id')
        const days = parseDays(q.get('days'), 90)
        const { sessions } = await store.sessions(days)
        const session = sessions.find((s) => s.id === id)
        if (!session) return error(res, 404, 'session not found in window')
        // 別のマシンのセッションの画像はこちらに無い
        const remote = isRemoteHost(session.host, selfHost())
        const transcript = remote ? '' : await progress.claudeTranscript(session)
        // Codex の画像生成（#575）。rollout は行のセッション ID から引く（リクエストからは受けない）
        const thread = !remote && session.agent === 'codex' ? sessionOf(session) : ''
        const rollout = thread ? ((await progress.codexRollout?.(thread)) ?? '') : ''
        if (codexImagesAt > 0) {
          if (!rollout) return error(res, 404, 'rollout がありません')
          const img = await codexImages.read(rollout, thread, path.slice(codexImagesAt + CODEX_IMAGES_SEGMENT.length), session.cwd)
          if (!img.ok) return error(res, img.status, img.reason)
          return await sendImage(req, res, img, q)
        }
        if (transcriptAt > 0) {
          if (!transcript) return error(res, 404, 'transcript がありません')
          const img = await transcriptImages.read(transcript, path.slice(transcriptAt + TRANSCRIPT_IMAGES_SEGMENT.length))
          if (!img.ok) return error(res, img.status, img.reason)
          return await sendImage(req, res, { ...img, name: `image.${img.type === 'jpeg' ? 'jpg' : img.type}` }, q)
        }
        if (remote) return json(res, { id, items: [] } satisfies GalleryResponse)
        const own = (await rowsNow(days)).filter((r) => entityId(r.session ?? '', r.repo ?? '', String(r.ts ?? '')) === id)
        const fromTranscript: GalleryItem[] = transcript
          ? (await transcriptImages.list(transcript)).map((t) => ({
              url: `${SESSIONS_PREFIX}${encodeURIComponent(id)}${TRANSCRIPT_IMAGES_SEGMENT}${t.key}`,
              name: t.from === 'user' ? '貼った画像' : 'ツールが開いた画像',
              at: t.at,
              ts: rowTsAtOrAfter(own, t.at, t.from),
              from: t.from,
              source: 'transcript' as const,
            }))
          : []
        // 画像を作ったターンの返答のバブルの下に出す（作った時刻以降で一番古い返答の行）。**そのターンが閉じた時刻まで**の行だけ
        // （#576 のレビュー）: エラーで終わった・止めたターンは行を書かないので、上限が無いと次のターンの返答に付く。
        // まだ閉じていないターンの画像は付けない（行が来ていない）
        // `view_image` で見せた cwd の中の画像（#704）も同じ並びで付ける。**本文にも書かれている画像は足さない**（バブルの中にもう出る）
        const fromCodex = rollout ? await codexImages.list(rollout, thread, session.cwd) : []
        const written = fromCodex.some((g) => g.file) ? new Set(await Promise.all([...imageTable(own, session.cwd).values()].map(realImagePath))) : new Set<string>()
        const generated: GalleryItem[] = fromCodex
          .filter((g) => !g.file || !written.has(g.file))
          .map((g) => ({
            url: `${SESSIONS_PREFIX}${encodeURIComponent(id)}${CODEX_IMAGES_SEGMENT}${encodeURIComponent(g.key)}`,
            name: g.file ? basename(g.file) : '生成した画像',
            at: g.at,
            ts: g.until ? rowTsAtOrAfter(own.filter((r) => Date.parse(String(r.ts ?? '')) <= Date.parse(g.until) + CODEX_ROW_SLACK_MS), g.at, 'agent') : '',
            from: 'agent' as const,
            source: g.file ? ('viewed' as const) : ('generated' as const),
          }))
        return json(res, { id, items: mergeGallery([...galleryFromRows(id, own), ...fromTranscript, ...generated]) } satisfies GalleryResponse)
      }
      // 返答に出てきたファイル（#603）。画像と同じく `<key>` は本文から拾った参照の鍵で、表に無ければ 404（パスはリクエストから受けない）。
      // **当面ループバックだけ**（tailnet 越しには出さない。名前で断る一覧をすり抜けた秘密が、手元の外に出ないように）
      const filesAt = path.startsWith(SESSIONS_PREFIX) ? path.indexOf(FILES_SEGMENT, SESSIONS_PREFIX.length) : -1
      if (filesAt > 0) {
        if (who.kind !== 'local') return error(res, 403, '返答のファイルは、SAI を動かしているマシンのブラウザからだけ開けます（tailnet 越しには出していません）')
        const id = sessionIdFrom(path, path.slice(filesAt))
        if (id === null) return error(res, 400, 'bad session id')
        const days = parseDays(q.get('days'), 90)
        const { sessions } = await store.sessions(days)
        const session = sessions.find((s) => s.id === id)
        if (!session) return error(res, 404, 'session not found in window')
        if (isRemoteHost(session.host, selfHost())) return error(res, 404, `別のマシン（${session.host}）のファイルは開けません`)
        const own = (await rowsNow(days)).filter((r) => entityId(r.session ?? '', r.repo ?? '', String(r.ts ?? '')) === id)
        const source = fileTable(own, session.cwd).get(path.slice(filesAt + FILES_SEGMENT.length))
        if (!source) return error(res, 404, 'このセッションの返答に出てきていないファイルです')
        const file = await readSessionFile(source)
        if (!file.ok) return error(res, file.status, file.reason)
        return json(res, { path: file.path, name: file.name, text: file.text, bytes: file.bytes } satisfies SessionFileResponse)
      }
      // 本文の画像（#321）。`<key>` はそのセッションのターン完了の行の本文から拾った参照の鍵で、表に無ければ 404（パスはリクエストから受けない）
      const imagesAt = path.startsWith(SESSIONS_PREFIX) ? path.indexOf(IMAGES_SEGMENT, SESSIONS_PREFIX.length) : -1
      if (imagesAt > 0) {
        const id = sessionIdFrom(path, path.slice(imagesAt))
        if (id === null) return error(res, 400, 'bad session id')
        const days = parseDays(q.get('days'), 90)
        const { sessions } = await store.sessions(days)
        const session = sessions.find((s) => s.id === id)
        if (!session) return error(res, 404, 'session not found in window')
        // 別のマシンのセッションのファイルはこちらに無い（同じパスのファイルがあっても別物）
        if (isRemoteHost(session.host, selfHost())) return error(res, 404, `別のマシン（${session.host}）のファイルは配れません`)
        const own = (await rowsNow(days)).filter((r) => entityId(r.session ?? '', r.repo ?? '', String(r.ts ?? '')) === id)
        const source = imageTable(own, session.cwd).get(path.slice(imagesAt + IMAGES_SEGMENT.length))
        if (!source) return error(res, 404, 'このセッションの本文に無い画像です')
        const img = await readSessionImage(source)
        if (!img.ok) return error(res, img.status, img.reason)
        return await sendImage(req, res, img, q)
      }
      if (path.startsWith(SESSIONS_PREFIX) && path.endsWith(TURN_STEPS_SUFFIX) && method === 'GET') {
        const id = sessionIdFrom(path, TURN_STEPS_SUFFIX)
        if (id === null) return error(res, 400, 'bad session id')
        return await getTurnSteps(res, id, q.get('ts') ?? '', parseDays(q.get('days'), 90))
      }
      if (path.startsWith(SESSIONS_PREFIX) && path.endsWith(TURN_SUFFIX) && method === 'GET') {
        const id = sessionIdFrom(path, TURN_SUFFIX)
        if (id === null) return error(res, 400, 'bad session id')
        return await getTurn(res, id, q.get('ts') ?? '', parseDays(q.get('days'), 90))
      }
      if (isProgress) {
        const id = sessionIdFrom(path, PROGRESS_SUFFIX)
        if (id === null) return error(res, 400, 'bad session id')
        return await getProgress(res, id, parseDays(q.get('days'), 90))
      }
      if (isPermissions) {
        const id = sessionIdFrom(path, PERMISSIONS_SUFFIX)
        if (id === null) return error(res, 400, 'bad session id')
        return await getPermissions(res, id, parseDays(q.get('days'), 90))
      }
      if (isProfile) {
        if (method === 'PUT') return await putProfile(req, res)
        const payload: ProfileResponse = { profile: (await profileNow()).profile }
        return json(res, payload)
      }
      if (isProfileIcon) {
        if (method === 'PUT') return await putProfileIcon(req, res, q.get('history'))
        if (method === 'DELETE') return await deleteProfileIcon(req, res)
        return await getIcon(req, res, PROFILE_ICON_ID, q.get('v'))
      }
      if (path === ICON_HISTORY_PATH) return await getIconHistory(res, q)
      if (isHistoryIcon) {
        const key = path.slice(ICON_HISTORY_PATH.length + 1)
        if (!isHistoryKey(key)) return error(res, 404, 'icon not found')
        if (method === 'DELETE') return await deleteHistoryIcon(req, res, key)
        return await getHistoryIcon(req, res, key, q.get('v'))
      }
      if (path === '/' || path === '/index.html') return await sendStatic(res, 'index.html')
      if (path.startsWith('/assets/')) return await sendStatic(res, path.slice(1))
      if (path === '/favicon.ico') return send(res, 204, '', 'image/x-icon')
      if (path === '/api/health') {
        const payload: HealthResponse = { ok: true, viewer }
        return json(res, payload)
      }
      if (isDigestFeedback) {
        if (method !== 'POST') return error(res, 405, 'method not allowed')
        return await postDigestFeedback(req, res)
      }
      if (isAuthLogin) {
        if (method !== 'GET' && method !== 'POST') return error(res, 405, 'method not allowed')
        if (isCrossOrigin(req)) return error(res, 403, 'cross-origin request rejected')
        // 応答に URL が載る。`json()` は `no-store` で返す
        const reply = (state: ReturnType<ClaudeLoginRunner['state']>) => json(res, state)
        if (method === 'GET') return reply(claudeLogin.state())
        let body: ClaudeLoginRequest
        try {
          body = (await readJson(req, MAX_LOGIN_BYTES)) as ClaudeLoginRequest
        } catch {
          return error(res, 400, 'invalid JSON body')
        }
        const action = body && typeof body === 'object' ? body.action : undefined
        if (action === 'cancel') return reply(claudeLogin.cancel())
        if (action === 'code') {
          if (!loginCode(body.code)) return error(res, 400, 'コードの形が違います（1 行で貼ってください）')
          if (!claudeLogin.code(String(body.code))) return error(res, 409, 'コードを待っているログインがありません（もう一度「ログインする」から）')
          return reply(claudeLogin.state())
        }
        if (action !== 'start') return error(res, 400, 'action は start / code / cancel のどれか')
        // 切れていると分かっているときだけ起こす・もう進んでいればそのまま返す、は `ClaudeLogin.start()` の中
        return reply(claudeLogin.start())
      }
      if (isAuthCheck) {
        if (method !== 'POST') return error(res, 405, 'method not allowed')
        if (isCrossOrigin(req)) return error(res, 403, 'cross-origin request rejected')
        const state = await claudeAuth.check()
        // ログインできていると分かったら、待っているログインの子は落とす（#577。Mac の端末でログインし直したあとに
        // 子が残っていると、別の画面からコードを渡して、いまのログインを差し替えられる）
        if (state?.loggedIn === true) claudeLogin.cancel()
        // 渡すのはログインしているかどうかだけ（メール・組織は持っていない）。分からなければ null
        const payload: ClaudeAuthCheckResponse = { logged_in: state ? state.loggedIn : null }
        return json(res, payload)
      }
      if (isSettings) {
        if (method === 'PUT') return await putSettings(req, res)
        return json(res, await settingsPayload())
      }
      // 各エージェントの使用量。ローカルのファイルを読むだけで、外の API は叩かない（#216）。
      // ファイルを漁るので 3 秒のポーリングには乗せず、画面が開いたときだけ取る（中でも 30 秒キャッシュ）
      if (path === USAGE_PATH) {
        const payload: UsageResponse = await usageStore.get()
        return json(res, payload)
      }
      // 使用量の画面（#602）。メモリに持っている turn-usage.jsonl の中身を足すだけ（ファイルは読み直さない・記録は触らない・API は叩かない）。
      // 3 秒のポーリングには乗せない（画面を開いたとき・期間を切り替えたときだけ）
      if (path === USAGE_REPORT_PATH) {
        const days = usageReportDays(q.get('days'))
        await usageReady
        // 呼び名は記録にあるセッションから引く（期間の中に行が無いセッションは ID のまま出る）。
        // 集計は「いまから days×24 時間前まで」、記録の窓は「今日を含む days 個の日付」なので、1 日多く読む
        const [{ sessions: known }, { entries: metas }] = await Promise.all([store.sessions(days + 1), metaStore.all()])
        const names = new Map<string, string>()
        for (const s of known) {
          const name = metas[s.id]?.name || s.title
          if (name) names.set(s.id, name)
        }
        return json(res, usageReport(usage.turns(), { now: Date.now(), days, names }) satisfies UsageReportResponse)
      }
      // 発言の本文の検索（#230）。索引は持たず、store が持っている行を舐めるだけ。
      // 3 秒のポーリングには乗せない（⌘K で打ち終わったときだけ叩く）
      // 新しいセッションを始められる場所（#319）。記録にある cwd のうち git の作業ツリーの中のものと、
      // 同じリポジトリの記録の無い兄弟 worktree。画面が新しいセッションの画面を開いたときだけ取る（ポーリングには乗せない）
      if (path === WORKSPACES_PATH) {
        const days = parseDays(q.get('days'), 90)
        const { sessions } = await sessionsWithMeta(days)
        return json(res, await workspacesOf(sessions))
      }

      if (path === SEARCH_PATH) {
        const days = parseDays(q.get('days'), 90)
        const rawQuery = q.get('q') ?? ''
        const words = searchWords(rawQuery)
        if (words.length === 0) {
          return json(res, { q: rawQuery, days, hits: [], truncated: false, scanned: 0 } satisfies SearchResponse)
        }
        const [rows, { sessions }] = await Promise.all([rowsNow(days), sessionsWithMeta(days)])
        const { hits, truncated } = searchRows(rows, words, sessions)
        return json(res, { q: rawQuery, days, hits, truncated, scanned: rows.length } satisfies SearchResponse)
      }

      // GitHub に出ている PR（#524）。**読むだけ**で、並べるのは記録で知っているリポジトリ（セッションの remote）だけ。
      // 3 秒のポーリングには乗せない（開いたとき・「読み直す」のときだけ）
      if (path === PRS_PATH || path.startsWith(`${PRS_PATH}/`)) {
        if (isPrReview ? method !== 'POST' : method !== 'GET') return error(res, 405, 'method not allowed')
        // GitHub に書く唯一の口（#526）。ほかの検査より先に、同一オリジンだけに絞る
        if (isPrReview && isCrossOrigin(req)) return error(res, 403, 'cross-origin request rejected')
        const { sessions: raw } = await store.sessions(PRS_REPO_DAYS)
        const known = knownRepos(await fillRepo(projects, raw))
        if (isPrReview) return await postPrReview(req, res, known, path.slice(PRS_PATH.length + 1, -PR_REVIEW_SUFFIX.length))
        if (path === PRS_PATH) {
          const fresh = q.get('fresh') === '1'
          const repos: PrRepo[] = await Promise.all(
            known.map(async (repo): Promise<PrRepo> => {
              const list = await prs.list(repo, fresh)
              return list ? { repo, prs: list } : { repo, prs: [], error: 'gh で読めませんでした' }
            }),
          )
          const rev = createHash('sha1').update(JSON.stringify(repos)).digest('hex').slice(0, 12)
          return json(res, { rev, available: prs.available, repos } satisfies PrsResponse)
        }
        // `/api/prs/<owner>/<repo>/<番号>`。リポジトリは知っているものの中から引く（任意の名前を gh に渡さない）
        const parts = path.slice(PRS_PATH.length + 1).split('/')
        const [owner = '', name = '', n = ''] = parts
        const repo = parts.length === 3 ? pickKnownRepo(known, `${owner}/${name}`) : ''
        if (!repo || !isPrNumber(n)) return error(res, 404, 'not found')
        // コメント（#600）は中身と並べて引く。読めなくても本文と差分は落とさない
        const [view, login, comments, lineComments] = await Promise.all([
          prs.view(repo, Number(n)),
          prs.available ? prs.viewer() : Promise.resolve(null),
          prs.comments(repo, Number(n)).catch(() => null),
          prs.lineComments(repo, Number(n)).catch(() => null),
        ])
        if (!view) return error(res, 502, 'gh で PR を読めませんでした')
        const out: PrDetailResponse = { repo, pr: view.pr, diff: { files: [], patch: '', truncated: false } }
        if (comments) {
          out.comments = comments.comments
          if (comments.omitted) out.comments_omitted = comments.omitted
        } else {
          out.comments_error = 'コメントを読めませんでした'
        }
        if (lineComments) {
          out.line_comments = lineComments.comments
          if (lineComments.omitted) out.line_comments_omitted = lineComments.omitted
        } else {
          out.line_comments_error = '差分の行に付いたコメントを読めませんでした'
        }
        // 投稿の口（#526）は `gh` でログインしている人が引けたときだけ出す
        if (login) out.review = { viewer: login, own: login.toLowerCase() === view.pr.author.toLowerCase() }
        if (view.patch === null) {
          out.diff_error = '差分を読めませんでした（大きすぎるか、時間切れ）'
        } else {
          // 見出しは切る前の本文から数える（切ったあとだと、落としたファイルの行数が 0 になる）
          const { patch, truncated } = clampPatch(view.patch)
          out.diff = { files: diffStats(view.patch), patch, truncated }
        }
        return json(res, out)
      }

      if (path === '/api/sessions') {
        const days = parseDays(q.get('days'), 7)
        const [{ rev: sessionsRev, sessions: withWaiting }, me] = await Promise.all([sessionsWithMeta(days), profileNow()])
        // 端末で答えたぶんの待ちは畳む（#255）。畳んだ集合を rev に混ぜないと画面が拾わない
        const { sessions, key: settled } = await settleWaiting(withWaiting)
        const rev = `${sessionsRev}~${me.rev}~${settled}~${terminalKey(sessions)}`
        // 前のターンが終わっていれば、預かっている返信を回してから載せる（#305。再起動で引き取った子はここで拾う）
        await drainAll()
        const replying = await withAuth(await replyingOf(sessions), sessions)
        const pendingApprovals = await approvalsNow(sessions)
        // 既定はアーカイブ済みを除く。archived=1 でアーカイブ済みだけ。total と filters はその集合の絞り込み前から作る
        const wantArchived = q.get('archived') === '1'
        const pool = sessions.filter((s) => Boolean(s.archived) === wantArchived)
        // 配っている画面が古ければ知らせる（画面はヘッダの下にバナーを出す）。判定は 30 秒に1回
        const build_stale = await freshness.stale()
        await scanDigest(days)
        // 記録側の版は窓の中の一番新しい行から。行が変われば rev も変わるので、ここでは rev に混ぜない
        const windowRows = await rowsNow(days)
        const record_version = recordVersionOf(windowRows)
        // 足りないフック（#567）。**このマシンの Claude の行が窓の中に無ければ言わない**（使っていない人・別のマシンの行だけの人に出さない）。
        // 設定が読めない・record.py に届くフックが 1 つも見えないときも言わない（null）
        const localClaude = windowRows.some((r) => r.agent === 'claude' && !isRemoteHost(r.host ?? '', selfHost()))
        const hooks_missing = (localClaude && claudeHooks.missing()) || []
        // Claude のログインが切れていると分かっているときだけ（#685。聞けていない・分からないは false）
        const claude_logged_out = claudeAuth.peek()?.loggedIn === false
        const body: SessionsResponse = {
          // 足りないフックは rev に混ぜる（設定を直したら、次の行を待たずにバナーが消える）
          rev: revWith(rev, replying, approvalMapKey(pendingApprovals), build_stale, digest.revKey(), `${queue.key()}|${loops.key()}|${waits.key()}`) + (hooks_missing.length ? `~hooks:${hooks_missing.join(',')}` : '') + (claude_logged_out ? '~auth:out' : ''),
          days,
          total: pool.length,
          sessions: withLastSummary(
            filterSessions(pool, {
              // 複数選べる（#529。`?project=a&project=b`）
              projects: cleanProjects(q.getAll('project')),
              repo: q.get('repo') ?? '',
              agent: q.get('agent') ?? '',
              date: q.get('date') ?? '',
              host: q.get('host') ?? '',
            }),
          ),
          filters: facets(pool),
          replying,
          queued: queue.snapshot(),
          loops: loops.snapshot(),
          waits: waits.snapshot(),
          approvals: pendingApprovals,
          build_stale,
          record_version,
          hooks_missing,
          claude_logged_out,
          profile: me.profile,
          viewer,
          host: selfHost(),
        }
        return jsonByRev(req, res, body)
      }

      if (path.startsWith(SESSIONS_PREFIX)) {
        const id = sessionIdFrom(path)
        if (id === null) return error(res, 400, 'bad session id')
        const days = parseDays(q.get('days'), 30)
        const [{ rev: sessionsRev, sessions: withWaiting }, me] = await Promise.all([sessionsWithMeta(days), profileNow()])
        // 一覧と同じく、端末で答えたぶんの待ちは畳む（#255。見出しの「待機中」も一緒に消える）
        const { sessions, key: settled } = await settleWaiting(withWaiting)
        const session = sessions.find((s) => s.id === id)
        if (!session) return error(res, 404, 'session not found in window')
        await scanDigest(days)
        // このセッションが一言を切っていれば載せない（#263）
        const every = await rowsNow(days)
        const own = every.filter((r) => entityId(r.session ?? '', r.repo ?? '', String(r.ts ?? '')) === id)
        await usageReady
        // 画面は直近のぶんだけ取る（#477。行の多いセッションで描き直しが重く、打鍵が止まる）。一言・使用量を付ける前に絞る
        const recent = parseRecent(q.get('recent'))
        const { rows: shown, older, dropped } = recent === null ? { rows: own, older: 0, dropped: [] } : recentRows(own, recent, q.get('focus') ?? '')
        const rows = usage.attach(session.meta?.digest_off ? shown : digest.attach(shown))
        await drainAll()
        const replying = await withAuth(await replyingOf(sessions), sessions)
        const pendingApprovals = await approvalsNow(sessions)
        // 別のセッションへのメッセージのようす（#311）。送った・止めた・再開したは agents.key() で rev に混ぜる
        const activity = await agentActivityOf(id, sessions)
        // 端末で開いた Claude が質問で止まっていれば、選択肢を transcript から（#333）。transcript に書かれる時刻は
        // 待ちの行と前後するので、rev に混ぜて後から届いたぶんも画面が拾う
        const question = await pendingQuestion(session, pendingApprovals)
        // `claude --bg` のセッションなら、端末で開くための短い ID（#462）。状態は rev に混ぜる
        const bg = await backgroundOf(session)
        // 別のセッションへ送ったメッセージへの返答（#588）。送り元が待たずにターンを終えても、この画面に並べる。
        // 描いている窓より前の返答は載せない（窓を広げれば出る）
        const shownFrom = older > 0 && shown[0] ? Date.parse(shown[0].ts) : -Infinity
        // 相手のアイコン（#666）は置き場から引く（相手がアーカイブ済み・一覧の窓の外でも、ファイルがあれば出る）
        const replyIcons = (await iconStore.all()).entries
        const replies = agentReplyRows(
          agents.sentBy(id, Infinity),
          every,
          (to) => {
            const target = sessions.find((s) => s.id === to)
            return target ? replierName(target) : to
          },
          (to) => {
            const icon = replyIcons.get(iconKey(to))
            return icon ? iconUrl(to, icon.version) : undefined
          },
        ).filter((r) => Date.parse(r.ts) >= shownFrom)
        // 人がこの画面の返答のバブルの下から相手へ送った返信（#700）と、相手がそれに返した行。返した行は同じ並びに混ぜる
        const nameOfTarget = (to: string) => {
          const target = sessions.find((s) => s.id === to)
          return target ? replierName(target) : to
        }
        const followed = agents.followupsBy(id)
        const followedUp = followupReplyRows(followed, every, nameOfTarget, (to) => {
          const icon = replyIcons.get(iconKey(to))
          return icon ? iconUrl(to, icon.version) : undefined
        })
        const followups: AgentFollowupLine[] = followed
          .filter((f) => Date.parse(f.at) >= shownFrom)
          .map((f) => {
            const replyTs = followedUp.answered.get(f.id)
            return { id: f.id, to: f.to, to_name: nameOfTarget(f.to), text: followupHead(f.text), sent_at: f.at, anchor: f.anchor, ...(replyTs ? { reply_ts: replyTs } : {}) }
          })
        const allReplies = [...replies, ...followedUp.rows.filter((r) => Date.parse(r.ts) >= shownFrom)].sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts))
        // その場で返信する入力欄のために、返答の相手のセッションも載せる（#700。案 next_ask も相手のもの）
        const replyTargetIds = new Set(allReplies.map((r) => entityId(r.session ?? '', r.repo ?? '', String(r.ts ?? ''))))
        const replyTargets = replyTargetIds.size > 0 ? withLastSummary(sessions.filter((s) => replyTargetIds.has(s.id))) : []
        // いまのコンテキスト量（#441）。(mtime, size) で覚えているので読み直しは軽い。rev には丸めた値だけ混ぜる
        const progressNow = isRemoteHost(session.host, selfHost()) ? null : await progress.read(session)
        const context = progressNow?.context_tokens ?? 0
        // いまのターンの間に画面から答えた許可（#693）。終わったターンのものは出さない: ターン完了の行のほか、
        // 止めたターン（行が来ない）は transcript / rollout の上で閉じた時刻で片付ける
        const answeredSince = answeredAfter(session.last_turn_ts ?? '', progressNow)
        const answeredHere = answered.of(id, answeredSince)
        const body: SessionDetailResponse = {
          rev: revWith(`${sessionsRev}~${me.rev}~${settled}~${terminalKey(sessions)}~${question?.asked_at ?? ''}~${bg ? `${bg.attach}:${bg.status}` : ''}~${contextRevKey(context)}~${allReplies.map((r) => r.agent_reply?.message_id).join(',')}~${answeredHere.map((a) => `${a.approval_id}:${a.behavior}`).join(',')}`, replying, approvalMapKey(pendingApprovals), false, `${digest.revKey()}|${usage.rev()}`, `${queue.key()}|${agents.key()}|${loops.key()}|${waits.key()}`),
          session: withLastSummary([session])[0]!,
          rows,
          older,
          older_prompts: olderPrompts(dropped),
          replying,
          queued: queue.snapshot(),
          loops: loops.snapshot(),
          waits: waits.snapshot(),
          ...(activity ? { agent: activity } : {}),
          approvals: pendingApprovals,
          ...(answeredHere.length > 0 ? { answered: answeredHere } : {}),
          profile: me.profile,
          host: selfHost(),
          ...(question ? { question } : {}),
          ...(bg ? { background: bg } : {}),
          ...(context > 0 ? { context_tokens: context } : {}),
          ...(allReplies.length > 0 ? { agent_replies: allReplies } : {}),
          ...(followups.length > 0 ? { agent_followups: followups } : {}),
          ...(replyTargets.length > 0 ? { agent_reply_sessions: replyTargets } : {}),
        }
        return jsonByRev(req, res, body)
      }

      if (path === '/api/feed') {
        const days = parseDays(q.get('days'), 3)
        const repo = q.get('repo') ?? ''
        // 複数選べる（#529。`?project=a&project=b`。どれか 1 つに当たる行を流す）
        const projects = cleanProjects(q.getAll('project'))
        // アーカイブ済みセッションの行は流さない（一覧から消えてもフィードに流れていたら隠した意味が無い）
        const [{ rev: sessionsRev, sessions }, me] = await Promise.all([sessionsWithMeta(days), profileNow()])
        const rev = `${sessionsRev}~${me.rev}~${terminalKey(sessions)}`
        const archived = new Set(sessions.filter((s) => s.archived).map((s) => s.id))
        let rows = await rowsNow(days)
        if (projects.length > 0) rows = rows.filter((r) => matchesProjects(projects, [rowProject(r)]))
        if (repo) rows = rows.filter((r) => r.repo === repo)
        if (archived.size) rows = rows.filter((r) => !archived.has(entityId(r.session ?? '', r.repo ?? '', String(r.ts ?? ''))))
        // 思考はフィードには出さないので運ばない（3秒ごとに全行を返す。セッション画面だけが使う）
        await scanDigest(days)
        // 一言を切っているセッションの行には載せない（#263）
        const noDigest = await digestOffIds()
        await usageReady
        rows = usage.attach(digest.attach(rows.map(stripThinking)))
        if (noDigest.size) rows = rows.map((r) => (r.summary && noDigest.has(entityId(r.session ?? '', r.repo ?? '', String(r.ts ?? ''))) ? { ...r, summary: undefined, summary_next: undefined } : r))
        await drainAll()
        const replying = await withAuth(await replyingOf(sessions), sessions)
        const pendingApprovals = await approvalsNow(sessions)
        // rev はメタ（アーカイブ）と処理中の集合、答え待ちの承認、ビルドが古いか、一言の有無も混ぜる
        const build_stale = await freshness.stale()
        const body: FeedResponse = {
          rev: revWith(rev, replying, approvalMapKey(pendingApprovals), build_stale, `${digest.revKey()}|${usage.rev()}`, queue.key()),
          days,
          rows,
          replying,
          queued: queue.snapshot(),
          approvals: pendingApprovals,
          build_stale,
          profile: me.profile,
          viewer,
        }
        return jsonByRev(req, res, body)
      }

      return error(res, 404, 'not found')
    } catch (err) {
      // 表示側が壊れても記録側には影響しない
      return error(res, 500, err instanceof Error ? `${err.name}: ${err.message}` : String(err))
    }
  }
  return Object.assign(handler, { dispose })
}
