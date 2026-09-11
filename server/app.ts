// ルーティング。main.ts が node:http に載せ、テストは createApp() を直接叩く。
import { createHash } from 'node:crypto'
import { homedir } from 'node:os'
import { appendFile, readFile, stat } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { extname, join, resolve, sep } from 'node:path'
import { ICON_MAX_BYTES, iconUrl } from '../shared/icon.ts'
import { ATTACHMENT_MAX_BYTES, ATTACHMENT_MAX_COUNT, ATTACHMENTS_DIR, withAttachments } from '../shared/attachments.ts'
import { mergeMeta } from '../shared/meta.ts'
import { mergeProfile, PROFILE_ICON_ID, profileIconUrl } from '../shared/profile.ts'
import { isPersonaId } from '../shared/persona.ts'
import { replyBlockedReason } from '../shared/reply.ts'
import { selfHost } from './host.ts'
import type {
  AgentSendRequest,
  AgentSendResponse,
  AgentSessionsResponse,
  AgentWaitResponse,
  ApprovalAnswer,
  ApprovalRequest,
  AttachmentResponse,
  FeedResponse,
  FeedRow,
  HealthResponse,
  Profile,
  ProfileResponse,
  ReplyError,
  ReplyingMap,
  ReplyQueueResponse,
  ReplyRequest,
  ReplyResponse,
  SessionDetailResponse,
  SessionDiffResponse,
  SessionDiffSummaryResponse,
  SessionProgressResponse,
  SessionIconResponse,
  SessionMetaResponse,
  SessionPermissionsResponse,
  SessionSkillsResponse,
  SearchResponse,
  SessionsResponse,
  SessionSummary,
  SettingsRequest,
  SettingsResponse,
  UsageResponse,
  Viewer,
} from '../shared/types.ts'
import { entityId, facets, filterSessions, recordVersionOf } from './rows/aggregate.ts'
import { rowProject } from '../shared/project.ts'
import { ICONS_DIR, IconStore, iconKey } from './meta/icons.ts'
import { alwaysAllowRule, ruleLabel } from '../shared/approvals.ts'
import { Approvals, WAIT_MS } from './approvals/approvals.ts'
import { BuildFreshness } from './local/buildFreshness.ts'
import { codexQueueCommand, codexWriterActive, runCodexQueue } from './reply/codex.ts'
import type { CodexQueue } from './reply/codex.ts'
import { CodexAppServer } from './reply/codexAppServer.ts'
import type { CodexApp } from './reply/codexAppServer.ts'
import { approvalMapKey, CodexDialogs, mergeApprovalMaps } from './reply/codexDialogs.ts'
import { clearSettled, settledKey, WaitingSettle } from './reply/waitingSettle.ts'
import type { WaitingSettleSource } from './reply/waitingSettle.ts'
import type { CodexDialogSource } from './reply/codexDialogs.ts'
import { DIGEST_FILE, DigestStore, createDigester } from './digest/digest.ts'
import { isDigestModel, isDigestProvider } from '../shared/digestSettings.ts'
import type { Digester } from './digest/digest.ts'
import { META_FILE, MetaStore } from './meta/meta.ts'
import { collectPermissions } from './approvals/permissions.ts'
import { compareUrl } from '../shared/diff.ts'
import { NotAGitRepo, RealGit, sessionDiff, sessionDiffSummary } from './git/diff.ts'
import { fillRepo, ProjectResolver } from './git/project.ts'
import type { Git } from './git/diff.ts'
import { prLookupFromEnv } from './git/pr.ts'
import type { PrLookup } from './git/pr.ts'
import { AttachmentStore } from './reply/attachments.ts'
import { PROFILE_FILE, ProfileStore } from './meta/profile.ts'
import { SETTINGS_FILE, SettingsStore } from './meta/settings.ts'
import type { Settings } from './meta/settings.ts'
import { isLinearWorkspace } from '../shared/refs.ts'
import { ProcessRunner, replyCommand } from './reply/runner.ts'
import { QUEUE_FILE, QUEUE_MAX, ReplyQueueStore } from './reply/replyQueue.ts'
import { AGENT_TOKEN_FILE, AGENT_TOKEN_HEADER, AgentMessages, ensureAgentToken, tokenMatches } from './reply/agentMessages.ts'
import type { AgentMessage } from './reply/agentMessages.ts'
import {
  AGENT_SEND_MAX,
  AGENT_TEXT_MAX_CHARS,
  AGENT_TURN_READ_BUDGET,
  agentEntry,
  agentTargets,
  budgetRefusal,
  clipReply,
  deliveredText,
  isDeliveryOf,
  replyOf,
  sessionLabel,
  usageRefusal,
} from '../shared/agentMessages.ts'
import { SkillStore } from './local/skills.ts'
import { claudeProjectsDir, codexSessionsDir, UsageStore } from './local/usage.ts'
import { ProgressReader } from './local/progress.ts'
import { isRemoteHost } from '../shared/host.ts'
import { searchRows } from './rows/search.ts'
import { searchWords } from '../shared/search.ts'
import { alive, RealTmux, realPs, TerminalBusy, TerminalGone, TerminalReplies, typeInto } from './reply/terminal.ts'
import type { PsFn, Tmux } from './reply/terminal.ts'
import type { Runner } from './reply/runner.ts'
import { Authenticator, tailscaleWhois } from './auth.ts'
import type { Identity } from './auth.ts'
import type { FeedStore } from './rows/store.ts'

export const MAX_DAYS = 366
/** 返信 body の上限。指示文なので十分 */
export const MAX_REPLY_BYTES = 64 * 1024

/** 表示名の body の上限。名前だけなので十分 */
export const MAX_META_BYTES = 4 * 1024

const SESSIONS_PREFIX = '/api/sessions/'
const APPROVALS_PATH = '/api/approvals'
const APPROVALS_PREFIX = '/api/approvals/'
const ANSWER_SUFFIX = '/answer'
/** 承認 body の上限。ツールの入力そのもの（Edit の new_string など）が入るので返信より大きめ */
export const MAX_APPROVAL_BYTES = 1024 * 1024
const SETTINGS_PATH = '/api/settings'
const USAGE_PATH = '/api/usage'
const SEARCH_PATH = '/api/search'
/** 設定 body の上限 */
export const MAX_SETTINGS_BYTES = 4 * 1024
const REPLY_SUFFIX = '/reply'
const META_SUFFIX = '/meta'
const ICON_SUFFIX = '/icon'
const SKILLS_SUFFIX = '/skills'
const PERMISSIONS_SUFFIX = '/permissions'
const DIFF_SUFFIX = '/diff'
const PROGRESS_SUFFIX = '/progress'
const ATTACHMENTS_SUFFIX = '/attachments'
/** 預かった返信（#305）。`DELETE /api/sessions/<id>/queue/<queue_id>` と `POST /api/sessions/<id>/queue/resume` */
const QUEUE_SEGMENT = '/queue/'
const QUEUE_RESUME = 'resume'
/** 預かった返信を起動するときに見る窓（POST の reply の既定と同じ） */
const QUEUE_DAYS = 90
/** エージェント用の口（#310）。SAI の MCP サーバ（approve-mcp.ts）の sai_* のツールだけが叩く。トークンを要り、ブラウザからは通さない */
const AGENT_PREFIX = '/api/agent/'
const AGENT_SESSIONS_PATH = '/api/agent/sessions'
const AGENT_SEND_PATH = '/api/agent/send'
const AGENT_WAIT_PATH = '/api/agent/wait'
/** sai_wait をサーバ側で待つ間、相手の返答の行が届いたかを見る間隔 */
const AGENT_POLL_MS = 1000
/** 配る側。GET /api/attachments/<dir>/<name> */
const ATTACHMENTS_PREFIX = `/api/${ATTACHMENTS_DIR}/`
const PROFILE_PATH = '/api/profile'
const PROFILE_ICON_PATH = '/api/profile/icon'

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
export function revWith(rev: string, replying: ReplyingMap, approvalsKey = '', buildStale = false, digestKey = '', queueKey = ''): string {
  const ids = Object.keys(replying).sort()
  if (ids.length === 0 && !approvalsKey && !buildStale && !digestKey && !queueKey) return rev
  const h = createHash('sha1')
  // 失敗が付いたときも画面に伝えたい（since は変わらないので、そのままでは rev が動かない）
  for (const id of ids) h.update(`${id}\n${replying[id]!.since}\n${replying[id]!.failed?.code ?? ''}\n`)
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
}

/** 起動の結果。HTTP には書かずに返すので、POST はそのまま応答にし、drain は預かりを止める理由にする */
interface Launched {
  status: number
  body: ReplyResponse | ReplyError
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
  /** 開いている Codex TUI の質問・許可ダイアログ監視。テストでは差し替える */
  codexDialogs?: CodexDialogSource
  /** SAIから開始するCodex turnのapp-server client。テストでは差し替える */
  codexApp?: CodexApp
  /** 端末で答えたぶんの待ちを畳む（#255）。テストでは差し替える */
  waitingSettle?: WaitingSettleSource
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
): Handler {
  const distRoot = resolve(distDir)
  // 端末に打ち込んだ返信の「処理中」。子プロセスの方（run）とは別に持ち、画面には合わせて出す
  const typed = terminal.replies ?? new TerminalReplies()
  const isAlive = terminal.alive ?? alive
  // project の無いセッションを cwd から埋める（cwd をキーにキャッシュ）
  const projects = new ProjectResolver(git)
  const isCodexWriterActive = terminal.codexWriterActive ?? codexWriterActive
  const queueCodex = terminal.codexQueue ?? runCodexQueue
  const codexDialogs = terminal.codexDialogs ?? new CodexDialogs(terminal.tmux, terminal.ps)
  const codexApp = terminal.codexApp ?? new CodexAppServer()
  const waitingSettle = terminal.waitingSettle ?? new WaitingSettle(terminal.tmux, terminal.ps)
  const codexAppEnabled = process.env.SAI_CODEX_APP_SERVER !== '0'
  const terminalEnabled = process.env.SAI_TERMINAL !== '0'
  /** 一番新しい行に pane と pid があり、pid が生きていれば端末で開いている */
  const terminalOf = (s: SessionSummary) => (terminalEnabled && s.pane && s.pid && isAlive(s.pid) ? { pane: s.pane, pid: s.pid } : null)
  /** 処理中の返信（子プロセス + 端末）。端末の分は、ターン完了の行が届いていれば先に片付ける */
  const replyingOf = (sessions: SessionSummary[]): ReplyingMap => {
    typed.settle((id) => sessions.find((s) => s.id === id)?.last_turn)
    return { ...typed.snapshot(), ...run.snapshot(), ...codexApp.replying() }
  }
  // 処理中の返信は replying.json にも持ち、サーバを再起動しても生きている分を引き取る（#100）
  const run: Runner = runner ?? new ProcessRunner(join(store.directory, 'reply.log'), join(store.directory, 'replying.json'))
  const metaStore = new MetaStore(join(store.directory, META_FILE))
  const iconStore = new IconStore(join(store.directory, ICONS_DIR))
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
  const agents = new AgentMessages()

  /**
   * 端末で人が答えたぶんの待ちを畳む（#255。#232 の積み残し）。行（集計）は触らず、応答を組み立てる
   * ときだけ空にするので、要対応・サイドバーの「待機中」・チャット見出しがまとめて正しくなる。
   * `SAI_TERMINAL=0` なら見に行かない（`CodexDialogs` と同じ）
   */
  const settleWaiting = async (sessions: SessionSummary[]): Promise<{ sessions: SessionSummary[]; key: string }> => {
    if (!terminalEnabled) return { sessions, key: '' }
    const settled = await waitingSettle.scan(sessions)
    return { sessions: clearSettled(sessions, settled), key: settledKey(settled) }
  }

  /** Claude、SAI管理のCodex、通常Codex TUIの検出専用ダイアログを合わせる。 */
  const approvalsNow = async (sessions: SessionSummary[]) =>
    mergeApprovalMaps(mergeApprovalMaps(approvals.snapshot(), codexApp.snapshot()), terminalEnabled ? await codexDialogs.scan(sessions) : {})

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

  /** 一言の対象を探して列に積む。3 秒ごとの応答のついでに呼ぶので軽い（無効なら何もしない） */
  const scanDigest = async (days: number): Promise<void> => {
    await digestReady
    if (!digest.enabled) return
    digest.scan(await store.rows(days))
  }

  /**
   * 集計済みのセッションにメタ（表示名・アーカイブ）とアイコン画像の URL を載せる。store のキャッシュ配列は触らず新しい配列を返す。
   * rev にメタファイルとアイコンの状態も混ぜるので、名前を付けた・画像を差し替えた・アーカイブしただけでも画面のポーリングが拾う。
   * アーカイブ済みかは `archived_at >= end` で決める（集計 aggregate.ts は JSONL だけから作る、を守る）。
   * アーカイブ後に行が増えると end が archived_at を追い越すので、メタを書き換えずに自動で戻る
   */
  const sessionsWithMeta = async (days: number): Promise<{ rev: string; sessions: SessionSummary[] }> => {
    const [{ rev, sessions: raw }, meta, icons] = await Promise.all([store.sessions(days), metaStore.all(), iconStore.all()])
    // project / remote の無い古い行のセッションは cwd から git で引いて埋める（cwd ごとに 1 回だけ。#182、#212）
    const sessions = await fillRepo(projects, raw)
    return {
      rev: `${rev}-${meta.rev}-${icons.rev}`,
      sessions: sessions.map((s) => {
        const m = meta.entries[s.id]
        const icon = icons.entries.get(iconKey(s.id))
        // 端末で開いているか（pid の生存）は毎回見る。rev には混ぜない（端末を閉じても次の行で rev が変わる）
        const out: SessionSummary = { ...s, terminal: terminalOf(s) }
        if (m) {
          out.meta = m
          if (!!m.archived_at && Date.parse(m.archived_at) >= Date.parse(s.end)) out.archived = true
        }
        if (icon) out.icon = iconUrl(s.id, icon.version)
        return out
      }),
    }
  }

  /**
   * 一覧の「最後の発言」に一言を載せる。無い行はそのまま。
   * **`digest_off` のセッションには載せない**（#263。切る前に作ってあるぶんも出さない。`digest.jsonl` は消さない）
   */
  const withLastSummary = (sessions: SessionSummary[]): SessionSummary[] => {
    if (digest.store.size === 0) return sessions
    return sessions.map((s) => {
      if (s.meta?.digest_off) return s
      const summary = digest.summaryFor(s.id, s.last_turn_ts ?? '')
      return summary ? { ...s, last_summary: summary } : s
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
  const settingsPayload = async (): Promise<SettingsResponse> => {
    await digestReady
    const s = await settingsStore.get()
    return {
      persona: s.persona,
      linear_workspace: s.linear_workspace,
      digest: digest.enabled,
      digest_on: s.digest,
      digest_error: digest.error,
      provider: digest.provider,
      digest_model: s.digest_model,
      model: digest.model,
    }
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
    if (Object.keys(patch).length === 0) return error(res, 400, 'persona / linear_workspace / digest / digest_provider / digest_model のどれかを送ってください')
    // 起動時の組み立て（settings.json の読み込み）が済んでから書く。後から古い値で組み直されないように
    await digestReady
    const saved = await settingsStore.set(patch)
    if (patch.digest !== undefined || patch.digest_provider !== undefined || patch.digest_model !== undefined) digest.configure(saved)
    return json(res, await settingsPayload())
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
    if (asked.length > ATTACHMENT_MAX_COUNT) return error(res, 400, `画像は ${ATTACHMENT_MAX_COUNT} 枚までです`)
    const attachments: string[] = []
    for (const p of asked) {
      const resolved = attachmentStore.resolvePath(id, p)
      if (!resolved) return error(res, 400, 'このセッションに預けた画像ではありません')
      attachments.push(resolved)
    }
    // 本文の末尾にパスを足す（Claude はこれを Read で読む。Codex は -i でも渡すが、記録と自分バブルのために本文にも）
    const text = withAttachments(typedText, attachments)
    if (!text) return error(res, 400, 'text is required')
    const replaceTyped = (body as ReplyRequest).replace_typed === true
    const forceProcess = (body as ReplyRequest).via === 'process'
    const wantQueue = (body as ReplyRequest).queue === true
    const out = await launch(id, text, attachments, { days, replaceTyped, forceProcess, url: selfUrl(req), queue: wantQueue })
    return json(res, out.body, out.status)
  }

  const refuse = (status: number, message: string): Launched => ({ status, body: { error: message } })

  /**
   * 返信を 1 本起動する（本文と添付は検査済み）。`POST .../reply` と、預かった返信を回す `drain()` の両方が通る（#305）。
   * 応答は書かずに返す
   */
  const launch = async (id: string, text: string, attachments: string[], o: LaunchOptions): Promise<Launched> => {
    const { sessions } = await store.sessions(o.days)
    const session = sessions.find((s) => s.id === id)
    if (!session) return refuse(404, 'session not found in window')
    const blocked = replyBlockedReason(session, selfHost())
    if (blocked) return refuse(400, blocked)

    // CLI に渡す生のセッションIDは URL から切り出さず、行の session を使う（entity.ts に逆変換を足さない）
    const rows = (await store.rows(o.days)).filter((r) => entityId(r.session ?? '', r.repo ?? '', String(r.ts ?? '')) === id)
    const raw = rows[rows.length - 1]?.session ?? ''
    if (!raw) return refuse(400, 'session id missing in rows')
    const cwd = session.cwd
    try {
      if (!cwd || !(await stat(cwd)).isDirectory()) throw new Error('not a directory')
    } catch {
      return refuse(400, `cwd が見つかりません: ${cwd || '(空)'}`)
    }
    const openTerminal = terminalOf(session)
    // 別プロセス（-p / app-server）のターンが動いているか、いま起動している最中か
    const busy = run.running(id) || codexApp.running(id) || launching.has(id)
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
    if (busy || (typed.running(id) && !openTerminal)) {
      return refuse(409, 'このセッションはまだ前の返信を処理中です')
    }
    launching.add(id)
    try {
      const out = await startTurn(id, session, raw, cwd, openTerminal, text, attachments, o)
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
    openTerminal: ReturnType<typeof terminalOf>,
    text: string,
    attachments: string[],
    o: LaunchOptions,
  ): Promise<Launched> => {
    const { replaceTyped, forceProcess } = o

    // 端末（tmux）で開いていれば、そのペインに打ち込む。別プロセスを立てないので端末にも出て、トークンも少ない。
    // ペインが無い・別のプロセスなら -p にフォールバック。入力中・ダイアログ中なら 409（何も打ち込まない）
    const term = openTerminal
    // Codex は開いているスレッドを exec resume すると active writer と競合する。tmux に打てない場合は
    // app-server の queue へ渡す（別プロセスは短く起動するが、writer を奪わず開いている会話に届く）。
    const codexActive = session.agent === 'codex' && ((await isCodexWriterActive(raw)) || (session.pid > 0 && isAlive(session.pid)))
    // モデルと画像は queue / exec resume の両方で使う。
    const own = await metaStore.get(id)
    const model = own?.model
    const sendQueue = async () => {
      const cmd = codexQueueCommand(raw, text, cwd, process.env, model, attachments)
      await appendFile(join(store.directory, 'reply.log'), `--- ${new Date().toISOString()} ${id} 開いている Codex へ queue ${JSON.stringify(cmd.args)} (cwd ${cwd})\n`).catch(() => {})
      try {
        await queueCodex(cmd)
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code
        const hint = code === 'ENOENT' ? `${cmd.bin} が見つかりません（サーバを起動した環境の PATH に ${cmd.bin} があるか確かめてください）` : ''
        return refuse(500, hint || `Codex へキュー送信できませんでした: ${err instanceof Error ? err.message : String(err)}`)
      }
      typed.start(id, text)
      const payload: ReplyResponse = { accepted: true, id, agent: session.agent, session: raw, cwd, via: 'queue' }
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
      try {
        await codexApp.start({ id, threadId: raw, text, cwd, model, attachments })
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code
        const hint = code === 'ENOENT' ? 'codex が見つかりません（サーバを起動した環境の PATH に codex があるか確かめてください）' : ''
        return refuse(500, hint || `Codex app-serverで再開できませんでした: ${err instanceof Error ? err.message : String(err)}`)
      }
      const payload: ReplyResponse = { accepted: true, id, agent: session.agent, session: raw, cwd, via: 'app-server' }
      return { status: 202, body: payload }
    }
    // 許可・質問を画面で答える配線。MCP の子プロセスはこのサーバと同じマシンで動くので、宛先はブラウザが来た Host ではなく
    // このサーバ自身が待ち受けているアドレス（ループバック）。Host だと tailscale serve 経由（https://<host>.ts.net → 127.0.0.1:8787）で
    // 開いた画面からの返信が `http://<host>.ts.net`（80 番、誰も聞いていない）に投げて「SAI に届かない: fetch failed」になる
    // トークンの置き場も渡すと、MCP サーバが別のセッションに話しかけるツール（sai_*）を出す（#310）
    const via = { url: o.url, entity: id, tokenFile: agentTokenPath }
    // セッションに返信のモデルが設定されていれば（PUT /api/sessions/<id>/meta の model）それで回す
    const cmd = replyCommand(session.agent, raw, text, cwd, process.env, via, model, own?.permission_mode, attachments)
    if (!cmd) return refuse(400, replyBlockedReason(session, selfHost()) || 'unsupported agent')
    try {
      // プロセスが終わったら、そのセッションの答え待ちは deny で片付ける（もう誰も答えを取りに来ない）。
      // 預かっている返信があれば続けて回す（#305）
      await run.start(id, cmd, () => {
        approvals.drop(id)
        void drain(id)
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
  const drain = async (id: string): Promise<void> => {
    const head = queue.peek(id)
    if (!head || queue.paused(id) || draining.has(id)) return
    if (run.running(id) || codexApp.running(id) || launching.has(id)) return
    draining.add(id)
    try {
      const last = run.snapshot()[id]
      if (last?.failed && resumedFailure.get(id) !== last.since) {
        queue.pause(id, `前の返信が失敗したので止めています（終了コード ${last.failed.code}）。続けるなら「続けて送る」`)
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
      if (out.status === 202) queue.shift(id, head.queue_id)
      else queue.pause(id, `預かった返信を送れませんでした: ${(out.body as ReplyError).error}`)
    } finally {
      draining.delete(id)
    }
  }

  /** 預かりのあるセッションを全部見る。画面のポーリングのついでに呼ぶ */
  const drainAll = async (): Promise<void> => {
    for (const id of queue.ids()) await drain(id)
  }

  // SAI 管理の Codex のターンが終わったら、預かりを回す（-p の exit と同じ扱い）
  codexApp.onTurnEnd?.((id) => void drain(id))

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
      const last = run.snapshot()[id]
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

  /** GET /api/agent/sessions?from=。話しかけられる相手（同じ project の、返信できる別のセッション） */
  const agentSessions = async (req: IncomingMessage, res: ServerResponse, q: URLSearchParams) => {
    const refusal = agentRefusal(req)
    if (refusal) return error(res, 403, refusal)
    const found = await agentFrom(q.get('from'))
    if (typeof found === 'string') return error(res, 409, found)
    const busy = (id: string) => run.running(id) || codexApp.running(id) || typed.running(id)
    const targets = agentTargets(found.sessions, found.session, selfHost())
    // 相手が読み直す量（直近の呼び出しの入力）。transcript の末尾を読むだけで、(mtime, size) が同じなら組み直さない（#311）
    const sizes = await Promise.all(targets.map(async (s) => (await progress.read(s)).context_tokens))
    const payload: AgentSessionsResponse = {
      from: found.session.id,
      sessions: targets.map((s, i) => agentEntry(s, busy(s.id), sizes[i] ?? 0)),
    }
    return json(res, payload)
  }

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
    const text = typeof b.text === 'string' ? b.text.trim() : ''
    if (!text) return error(res, 400, 'text が要ります')
    if (text.length > AGENT_TEXT_MAX_CHARS) return error(res, 400, `送れるのは ${AGENT_TEXT_MAX_CHARS} 字までです。短くまとめてください`)
    const found = await agentFrom(b.from)
    if (typeof found === 'string') return error(res, 409, found)
    const to = typeof b.to === 'string' ? b.to : ''
    const target = agentTargets(found.sessions, found.session, selfHost()).find((s) => s.id === to)
    if (!target) return error(res, 403, 'その相手には送れません（同じリポジトリの、SAI から返信できる別のセッションだけ。sai_sessions で確かめてください）')
    const limit = agents.refusal(found.session.id, found.turn)
    if (limit) return error(res, 429, limit)
    // 使用量の枠が残り少なければ送らない。見るのは相手のエージェントの枠（受け取って読み直すのは相手。#311）
    const overUsage = usageRefusal(await usageStore.get(), target.agent)
    if (overUsage) return error(res, 429, overUsage)
    // 1 ターンで相手に読み直させる量の予算（#311）。相手の大きさは transcript / rollout の直近の呼び出しの入力
    const context = (await progress.read(target)).context_tokens
    const overBudget = budgetRefusal(agents.readInTurn(found.session.id, found.turn), context)
    if (overBudget) return error(res, 429, overBudget)
    const messageId = agents.newId()
    const delivered = deliveredText({ label: sessionLabel(found.session), project: found.session.project }, messageId, text)
    const out = await launch(to, delivered, [], { days: QUEUE_DAYS, replaceTyped: false, forceProcess: false, url: selfUrl(req), queue: true, origin: messageId })
    if (out.status !== 202) return json(res, out.body, out.status)
    const via = (out.body as ReplyResponse).via
    agents.record({ message_id: messageId, from: found.session.id, to, text, since: new Date().toISOString() }, found.turn, context)
    await appendFile(join(store.directory, 'reply.log'), `--- ${new Date().toISOString()} ${found.session.id} → ${to} メッセージ ${messageId}（${via}）\n`).catch(() => {})
    const payload: AgentSendResponse = {
      message_id: messageId,
      to,
      via,
      sent: agents.sentInTurn(found.session.id, found.turn),
      limit: AGENT_SEND_MAX,
      context_tokens: context,
      read_tokens: agents.readInTurn(found.session.id, found.turn),
      read_budget: AGENT_TURN_READ_BUDGET,
    }
    return json(res, payload, 202)
  }

  /** 送ったメッセージの結果。相手のそのターンが終わっていれば返答、失敗・止まっていれば理由。まだなら null */
  const agentResult = async (message: AgentMessage): Promise<AgentWaitResponse | null> => {
    const base = { message_id: message.message_id, to: message.to }
    const answered = replyOf(await store.rows(QUEUE_DAYS), message.to, message.message_id)
    if (answered) return { ...base, status: 'done', text: clipReply(answered.text ?? '') }
    const turn = run.snapshot()[message.to]
    if (turn?.failed && isDeliveryOf(turn.text, message.message_id)) {
      return { ...base, status: 'failed', error: `終了コード ${turn.failed.code}${turn.failed.tail ? `: ${turn.failed.tail}` : ''}` }
    }
    // 預かりの先頭のまま止まった（前の返信が失敗した・起動できなかった）
    const paused = queue.paused(message.to)
    if (paused && isDeliveryOf(queue.peek(message.to)?.text, message.message_id)) return { ...base, status: 'failed', error: paused }
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
      const result = await agentResult(message)
      if (result) return json(res, result)
      if (Date.now() >= until) return json(res, { message_id: message.message_id, to: message.to, status: 'pending' } satisfies AgentWaitResponse, 202)
      await new Promise((r) => setTimeout(r, AGENT_POLL_MS))
    }
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
      return json(res, { ok: true, approval_id: approvalId, behavior: answer.behavior })
    }
    const current = approvals.get(approvalId)
    if (!current) return error(res, 404, 'approval not found')
    const answer: ApprovalAnswer = b.behavior === 'allow'
      ? { behavior: 'allow', updatedInput: b.updatedInput && typeof b.updatedInput === 'object' && !Array.isArray(b.updatedInput) ? b.updatedInput : current.input }
      : { behavior: 'deny', message: typeof b.message === 'string' && b.message.trim() ? b.message.trim() : 'SAI の画面で拒否された' }
    if (answer.behavior === 'allow' && b.remember === 'local') {
      // 「常に許可」。ルールは画面から受け取らず、預かっているツール名と入力からサーバが組み立てる。
      // CLI がそれを cwd の .claude/settings.local.json に書く（端末の「今後も許可」と同じ）
      const rule = alwaysAllowRule(current.tool_name, current.input)
      if (!rule) return error(res, 400, 'このツールには「常に許可」は無い')
      answer.updatedPermissions = [{ type: 'addRules', rules: [rule], behavior: 'allow', destination: 'localSettings' }]
    }
    if (!approvals.answer(approvalId, answer)) return error(res, 409, 'already answered')
    return json(res, { ok: true, approval_id: approvalId, behavior: answer.behavior, remembered: answer.updatedPermissions ? ruleLabel(answer.updatedPermissions[0]!.rules[0]!) : undefined })
  }

  /**
   * PUT /api/sessions/<id>/meta。いまの値に body を重ねる（省略は据え置き、空や null は消す）。
   * アーカイブは archived_at を載せるだけで、専用のエンドポイントは無い。窓の中に無いセッションには付けない
   */
  /**
   * POST /api/sessions/<id>/attachments。body は画像そのもの（Content-Type は見ず中身で判定）。
   * 返した path を返信の `attachments` に入れると、本文の末尾に足されて CLI に渡る
   */
  const postAttachment = async (req: IncomingMessage, res: ServerResponse, id: string, days: number) => {
    if (isCrossOrigin(req)) return error(res, 403, 'cross-origin request rejected')
    let bytes: Buffer
    try {
      bytes = await readBody(req, ATTACHMENT_MAX_BYTES)
    } catch (err) {
      const big = err instanceof Error && err.message === 'body too large'
      return error(res, big ? 413 : 400, big ? `画像は ${ATTACHMENT_MAX_BYTES / 1024 / 1024}MB までです` : err instanceof Error ? err.message : 'bad body')
    }
    if (bytes.length === 0) return error(res, 400, '画像が空です')
    const { sessions } = await store.sessions(days)
    if (!sessions.some((s) => s.id === id)) return error(res, 404, 'session not found in window')
    const { attachment, error: reason } = await attachmentStore.put(id, bytes)
    if (!attachment) return error(res, 400, reason || '保存できませんでした')
    const payload: AttachmentResponse = { id, path: attachment.path, url: attachment.url, mime: attachment.mime, size: attachment.size }
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
    return json(res, { ...empty, sources, rules } satisfies SessionPermissionsResponse)
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
    return json(res, await progress.read(session))
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
  const putIcon = async (req: IncomingMessage, res: ServerResponse, id: string, days: number) => {
    if (isCrossOrigin(req)) return error(res, 403, 'cross-origin request rejected')
    const bytes = await readIconBody(req, res)
    if (!bytes) return
    const { sessions } = await store.sessions(days)
    if (!sessions.some((s) => s.id === id)) return error(res, 404, 'session not found in window')
    const { icon, error: reason } = await iconStore.put(id, bytes)
    if (reason || !icon) return error(res, 400, reason || '保存できませんでした')
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
  const putProfileIcon = async (req: IncomingMessage, res: ServerResponse) => {
    if (isCrossOrigin(req)) return error(res, 403, 'cross-origin request rejected')
    const bytes = await readIconBody(req, res)
    if (!bytes) return
    const { icon, error: reason } = await iconStore.put(PROFILE_ICON_ID, bytes)
    if (reason || !icon) return error(res, 400, reason || '保存できませんでした')
    const payload: ProfileResponse = { profile: (await profileNow()).profile }
    return json(res, payload)
  }
  const deleteProfileIcon = async (req: IncomingMessage, res: ServerResponse) => {
    if (isCrossOrigin(req)) return error(res, 403, 'cross-origin request rejected')
    await iconStore.remove(PROFILE_ICON_ID)
    const payload: ProfileResponse = { profile: (await profileNow()).profile }
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

  return async (req, res) => {
    // 全リクエストに先に掛ける。tailnet 経由（Serve のヘッダ付き）は whois で本人を確かめ、合わなければ 401。
    // ヘッダ無しはループバックからの直アクセスだけ通す
    let who: Identity | null
    try {
      who = await auth.identify(req)
    } catch (err) {
      return error(res, 500, err instanceof Error ? `${err.name}: ${err.message}` : String(err))
    }
    if (!who) return error(res, 401, 'unauthorized: Tailscale-User-Login が whois と一致しない')
    const viewer = viewerOf(who)
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    const q = url.searchParams
    const path = url.pathname
    const isReply = path.startsWith(SESSIONS_PREFIX) && path.endsWith(REPLY_SUFFIX)
    const isMeta = path.startsWith(SESSIONS_PREFIX) && path.endsWith(META_SUFFIX)
    const isIcon = path.startsWith(SESSIONS_PREFIX) && path.endsWith(ICON_SUFFIX)
    const isSkills = path.startsWith(SESSIONS_PREFIX) && path.endsWith(SKILLS_SUFFIX)
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
    const isAsk = path === APPROVALS_PATH
    const isAnswer = path.startsWith(APPROVALS_PREFIX) && path.endsWith(ANSWER_SUFFIX)
    const isProfile = path === PROFILE_PATH
    const isProfileIcon = path === PROFILE_ICON_PATH
    const isSettings = path === SETTINGS_PATH
    const method = req.method ?? 'GET'
    // 書き込みは「返信は POST」「表示名は PUT」「アイコンは PUT / DELETE」「承認の預かりと答えは POST」「自分の表示名は PUT、アイコンは PUT / DELETE」
    // 「設定は PUT」「預かった返信の再開は POST、取り消しは DELETE」だけ。それ以外は GET / HEAD のみ
    const writable =
      (method === 'POST' && (isReply || isAsk || isAnswer || isAttachUpload || isQueue || path === AGENT_SEND_PATH)) ||
      (method === 'DELETE' && isQueue) ||
      (method === 'PUT' && (isMeta || isProfile || isSettings)) ||
      ((method === 'PUT' || method === 'DELETE') && (isIcon || isProfileIcon))
    if (!writable && method !== 'GET' && method !== 'HEAD') return error(res, 405, 'method not allowed')
    try {
      if (isAgent) {
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
      if (isReply) {
        if (method !== 'POST') return error(res, 405, 'method not allowed')
        const id = sessionIdFrom(path, REPLY_SUFFIX)
        if (id === null) return error(res, 400, 'bad session id')
        return await reply(req, res, id, parseDays(q.get('days'), 90))
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
        // スキルは Claude Code の仕組み。Codex には無いので空で返す
        const payload: SessionSkillsResponse = { id, skills: session.agent === 'claude' ? await skillStore.forCwd(session.cwd) : [] }
        return json(res, payload)
      }
      if (isIcon) {
        const id = sessionIdFrom(path, ICON_SUFFIX)
        if (id === null) return error(res, 400, 'bad session id')
        if (method === 'PUT') return await putIcon(req, res, id, parseDays(q.get('days'), 90))
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
        return await postAttachment(req, res, id, parseDays(q.get('days'), 90))
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
        // 名前が中身のハッシュなので、同じ URL の中身は変わらない
        res.writeHead(200, { 'Content-Type': found.mime, 'Content-Length': body.length, 'Cache-Control': 'private, max-age=31536000, immutable' })
        res.end(req.method === 'HEAD' ? undefined : body)
        return
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
        if (method === 'PUT') return await putProfileIcon(req, res)
        if (method === 'DELETE') return await deleteProfileIcon(req, res)
        return await getIcon(req, res, PROFILE_ICON_ID, q.get('v'))
      }
      if (path === '/' || path === '/index.html') return await sendStatic(res, 'index.html')
      if (path.startsWith('/assets/')) return await sendStatic(res, path.slice(1))
      if (path === '/favicon.ico') return send(res, 204, '', 'image/x-icon')
      if (path === '/api/health') {
        const payload: HealthResponse = { ok: true, viewer }
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
      // 発言の本文の検索（#230）。索引は持たず、store が持っている行を舐めるだけ。
      // 3 秒のポーリングには乗せない（⌘K で打ち終わったときだけ叩く）
      if (path === SEARCH_PATH) {
        const days = parseDays(q.get('days'), 90)
        const rawQuery = q.get('q') ?? ''
        const words = searchWords(rawQuery)
        if (words.length === 0) {
          return json(res, { q: rawQuery, days, hits: [], truncated: false, scanned: 0 } satisfies SearchResponse)
        }
        const [rows, { sessions }] = await Promise.all([store.rows(days), sessionsWithMeta(days)])
        const { hits, truncated } = searchRows(rows, words, sessions)
        return json(res, { q: rawQuery, days, hits, truncated, scanned: rows.length } satisfies SearchResponse)
      }

      if (path === '/api/sessions') {
        const days = parseDays(q.get('days'), 7)
        const [{ rev: sessionsRev, sessions: withWaiting }, me] = await Promise.all([sessionsWithMeta(days), profileNow()])
        // 端末で答えたぶんの待ちは畳む（#255）。畳んだ集合を rev に混ぜないと画面が拾わない
        const { sessions, key: settled } = await settleWaiting(withWaiting)
        const rev = `${sessionsRev}~${me.rev}~${settled}`
        // 前のターンが終わっていれば、預かっている返信を回してから載せる（#305。再起動で引き取った子はここで拾う）
        await drainAll()
        const replying = replyingOf(sessions)
        const pendingApprovals = await approvalsNow(sessions)
        // 既定はアーカイブ済みを除く。archived=1 でアーカイブ済みだけ。total と filters はその集合の絞り込み前から作る
        const wantArchived = q.get('archived') === '1'
        const pool = sessions.filter((s) => Boolean(s.archived) === wantArchived)
        // 配っている画面が古ければ知らせる（画面はヘッダの下にバナーを出す）。判定は 30 秒に1回
        const build_stale = await freshness.stale()
        await scanDigest(days)
        // 記録側の版は窓の中の一番新しい行から。行が変われば rev も変わるので、ここでは rev に混ぜない
        const record_version = recordVersionOf(await store.rows(days))
        const body: SessionsResponse = {
          rev: revWith(rev, replying, approvalMapKey(pendingApprovals), build_stale, digest.revKey(), queue.key()),
          days,
          total: pool.length,
          sessions: withLastSummary(
            filterSessions(pool, {
              project: q.get('project') ?? '',
              repo: q.get('repo') ?? '',
              agent: q.get('agent') ?? '',
              date: q.get('date') ?? '',
              host: q.get('host') ?? '',
            }),
          ),
          filters: facets(pool),
          replying,
          queued: queue.snapshot(),
          approvals: pendingApprovals,
          build_stale,
          record_version,
          profile: me.profile,
          viewer,
          host: selfHost(),
        }
        return json(res, body)
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
        const own = (await store.rows(days)).filter((r) => entityId(r.session ?? '', r.repo ?? '', String(r.ts ?? '')) === id)
        const rows = session.meta?.digest_off ? own : digest.attach(own)
        await drainAll()
        const replying = replyingOf(sessions)
        const pendingApprovals = await approvalsNow(sessions)
        const body: SessionDetailResponse = {
          rev: revWith(`${sessionsRev}~${me.rev}~${settled}`, replying, approvalMapKey(pendingApprovals), false, digest.revKey(), queue.key()),
          session: withLastSummary([session])[0]!,
          rows,
          replying,
          queued: queue.snapshot(),
          approvals: pendingApprovals,
          profile: me.profile,
          host: selfHost(),
        }
        return json(res, body)
      }

      if (path === '/api/feed') {
        const days = parseDays(q.get('days'), 3)
        const repo = q.get('repo') ?? ''
        const project = q.get('project') ?? ''
        // アーカイブ済みセッションの行は流さない（一覧から消えてもフィードに流れていたら隠した意味が無い）
        const [{ rev: sessionsRev, sessions }, me] = await Promise.all([sessionsWithMeta(days), profileNow()])
        const rev = `${sessionsRev}~${me.rev}`
        const archived = new Set(sessions.filter((s) => s.archived).map((s) => s.id))
        let rows = await store.rows(days)
        if (project) rows = rows.filter((r) => rowProject(r) === project)
        if (repo) rows = rows.filter((r) => r.repo === repo)
        if (archived.size) rows = rows.filter((r) => !archived.has(entityId(r.session ?? '', r.repo ?? '', String(r.ts ?? ''))))
        // 思考はフィードには出さないので運ばない（3秒ごとに全行を返す。セッション画面だけが使う）
        await scanDigest(days)
        // 一言を切っているセッションの行には載せない（#263）
        const noDigest = await digestOffIds()
        rows = digest.attach(rows.map(stripThinking))
        if (noDigest.size) rows = rows.map((r) => (r.summary && noDigest.has(entityId(r.session ?? '', r.repo ?? '', String(r.ts ?? ''))) ? { ...r, summary: undefined } : r))
        await drainAll()
        const replying = replyingOf(sessions)
        const pendingApprovals = await approvalsNow(sessions)
        // rev はメタ（アーカイブ）と処理中の集合、答え待ちの承認、ビルドが古いか、一言の有無も混ぜる
        const build_stale = await freshness.stale()
        const body: FeedResponse = {
          rev: revWith(rev, replying, approvalMapKey(pendingApprovals), build_stale, digest.revKey(), queue.key()),
          days,
          rows,
          replying,
          queued: queue.snapshot(),
          approvals: pendingApprovals,
          build_stale,
          profile: me.profile,
          viewer,
        }
        return json(res, body)
      }

      return error(res, 404, 'not found')
    } catch (err) {
      // 表示側が壊れても記録側には影響しない
      return error(res, 500, err instanceof Error ? `${err.name}: ${err.message}` : String(err))
    }
  }
}
