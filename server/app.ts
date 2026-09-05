// ルーティング。main.ts が node:http に載せ、テストは createApp() を直接叩く。
import { createHash } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { extname, join, resolve, sep } from 'node:path'
import { ICON_MAX_BYTES, iconUrl } from '../shared/icon.ts'
import { mergeMeta } from '../shared/meta.ts'
import { mergeProfile, PROFILE_ICON_ID, profileIconUrl } from '../shared/profile.ts'
import { isPersonaId } from '../shared/persona.ts'
import { replyBlockedReason } from '../shared/reply.ts'
import type {
  ApprovalAnswer,
  ApprovalRequest,
  DigestBackfillResponse,
  FeedResponse,
  Profile,
  ProfileResponse,
  FeedRow,
  HealthResponse,
  ReplyingMap,
  ReplyRequest,
  ReplyResponse,
  SessionDetailResponse,
  SessionIconResponse,
  SessionMetaResponse,
  SessionsResponse,
  SessionSummary,
  SettingsRequest,
  SettingsResponse,
  Viewer,
} from '../shared/types.ts'
import { entityId, facets, filterSessions, recordVersionOf } from './aggregate.ts'
import { ICONS_DIR, IconStore, iconKey } from './icons.ts'
import { alwaysAllowRule, ruleLabel } from '../shared/approvals.ts'
import { Approvals, WAIT_MS } from './approvals.ts'
import { BuildFreshness } from './buildFreshness.ts'
import { DIGEST_FILE, DigestStore, digesterFromEnv } from './digest.ts'
import type { Digester } from './digest.ts'
import { META_FILE, MetaStore } from './meta.ts'
import { PROFILE_FILE, ProfileStore } from './profile.ts'
import { SETTINGS_FILE, SettingsStore } from './settings.ts'
import { ProcessRunner, replyCommand } from './runner.ts'
import type { Runner } from './runner.ts'
import { Authenticator, tailscaleWhois } from './auth.ts'
import type { Identity } from './auth.ts'
import type { FeedStore } from './store.ts'

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
const DIGEST_BACKFILL_PATH = '/api/digest/backfill'
/** 設定 body の上限 */
export const MAX_SETTINGS_BYTES = 4 * 1024
const REPLY_SUFFIX = '/reply'
const META_SUFFIX = '/meta'
const ICON_SUFFIX = '/icon'
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
export function revWith(rev: string, replying: ReplyingMap, approvalsKey = '', buildStale = false, digestKey = ''): string {
  const ids = Object.keys(replying).sort()
  if (ids.length === 0 && !approvalsKey && !buildStale && !digestKey) return rev
  const h = createHash('sha1')
  for (const id of ids) h.update(`${id}\n${replying[id]!.since}\n`)
  h.update(`approvals:${approvalsKey}`)
  // ビルドが古いかが変わったら画面に伝えたい（画面は rev が同じなら描き直さない）
  h.update(`stale:${buildStale ? 1 : 0}`)
  // 一言（digest）ができたら、JSONL が変わらなくても差し替えたい
  h.update(`digest:${digestKey}`)
  return `${rev}:${h.digest('hex').slice(0, 8)}`
}

/** フィード用に行から thinking を落とす。無い行はそのまま返す（コピーしない） */
export function stripThinking(row: FeedRow): FeedRow {
  if (row.thinking === undefined) return row
  const rest = { ...row }
  delete rest.thinking
  return rest
}

export type Handler = (req: IncomingMessage, res: ServerResponse) => Promise<void>

export function createApp(
  store: FeedStore,
  distDir: string,
  runner?: Runner,
  approvals: Approvals = new Approvals(),
  freshness: BuildFreshness = new BuildFreshness(distDir),
  digester?: Digester,
  auth: Authenticator = new Authenticator(tailscaleWhois()),
): Handler {
  const distRoot = resolve(distDir)
  // 処理中の返信は replying.json にも持ち、サーバを再起動しても生きている分を引き取る（#100）
  const run: Runner = runner ?? new ProcessRunner(join(store.directory, 'reply.log'), join(store.directory, 'replying.json'))
  const metaStore = new MetaStore(join(store.directory, META_FILE))
  const iconStore = new IconStore(join(store.directory, ICONS_DIR))
  const profileStore = new ProfileStore(join(store.directory, PROFILE_FILE))

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
  // 一言コメント（digest）。テストは Summarizer を差し替えた Digester を渡す。既定は環境変数で組む（SAI_DIGEST=1 でなければ無効）
  const digest: Digester = digester ?? digesterFromEnv(store.directory, new DigestStore(join(store.directory, DIGEST_FILE)), settingsStore)
  const digestReady = digest.store.load()

  /** 一言の対象を探して列に積む。3 秒ごとの応答のついでに呼ぶので軽い（無効なら何もしない） */
  const scanDigest = async (days: number): Promise<void> => {
    if (!digest.enabled) return
    await digestReady
    digest.scan(await store.rows(days))
  }

  /**
   * 集計済みのセッションにメタ（表示名・アーカイブ）とアイコン画像の URL を載せる。store のキャッシュ配列は触らず新しい配列を返す。
   * rev にメタファイルとアイコンの状態も混ぜるので、名前を付けた・画像を差し替えた・アーカイブしただけでも画面のポーリングが拾う。
   * アーカイブ済みかは `archived_at >= end` で決める（集計 aggregate.ts は JSONL だけから作る、を守る）。
   * アーカイブ後に行が増えると end が archived_at を追い越すので、メタを書き換えずに自動で戻る
   */
  const sessionsWithMeta = async (days: number): Promise<{ rev: string; sessions: SessionSummary[] }> => {
    const [{ rev, sessions }, meta, icons] = await Promise.all([store.sessions(days), metaStore.all(), iconStore.all()])
    if (!meta.rev && !icons.rev) return { rev, sessions }
    return {
      rev: `${rev}-${meta.rev}-${icons.rev}`,
      sessions: sessions.map((s) => {
        const m = meta.entries[s.id]
        const icon = icons.entries.get(iconKey(s.id))
        if (!m && !icon) return s
        const out: SessionSummary = { ...s }
        if (m) {
          out.meta = m
          if (!!m.archived_at && Date.parse(m.archived_at) >= Date.parse(s.end)) out.archived = true
        }
        if (icon) out.icon = iconUrl(s.id, icon.version)
        return out
      }),
    }
  }

  /** 一覧の「最後の発言」に一言を載せる。無い行はそのまま */
  const withLastSummary = (sessions: SessionSummary[]): SessionSummary[] => {
    if (digest.store.size === 0) return sessions
    return sessions.map((s) => {
      const summary = digest.summaryFor(s.id, s.last_turn_ts ?? '')
      return summary ? { ...s, last_summary: summary } : s
    })
  }

  /** GET/PUT /api/settings。PUT は同一オリジンのみ。変えられるのは性格だけ（digest の有効/無効とモデルは環境変数） */
  const settingsPayload = async (): Promise<SettingsResponse> => ({ ...(await settingsStore.get()), digest: digest.enabled, model: digest.model })
  const putSettings = async (req: IncomingMessage, res: ServerResponse) => {
    if (isCrossOrigin(req)) return error(res, 403, 'cross-origin request rejected')
    let body: unknown
    try {
      body = await readJson(req, MAX_SETTINGS_BYTES)
    } catch (err) {
      return error(res, 400, err instanceof Error ? err.message : 'bad body')
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)) return error(res, 400, 'body はオブジェクトで送ってください')
    const b = body as Partial<SettingsRequest>
    if (!isPersonaId(b.persona)) return error(res, 400, 'persona が不明です（shared/persona.ts にある id を送ってください）')
    await settingsStore.set({ persona: b.persona })
    return json(res, await settingsPayload())
  }

  /** POST /api/digest/backfill?n=20&days=7。直近 n 件の一言を作る（既定オフのときは 400）。同一オリジンのみ */
  const backfillDigest = async (req: IncomingMessage, res: ServerResponse, n: number, days: number) => {
    if (isCrossOrigin(req)) return error(res, 403, 'cross-origin request rejected')
    if (!digest.enabled) return error(res, 400, '一言は無効です（SAI_DIGEST=1 で起動してください）')
    await digestReady
    const queued = digest.backfill(await store.rows(days), n)
    const payload: DigestBackfillResponse = { queued }
    return json(res, payload, 202)
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
    const text = typeof (body as ReplyRequest | null)?.text === 'string' ? (body as ReplyRequest).text.trim() : ''
    if (!text) return error(res, 400, 'text is required')

    const { sessions } = await store.sessions(days)
    const session = sessions.find((s) => s.id === id)
    if (!session) return error(res, 404, 'session not found in window')
    const blocked = replyBlockedReason(session)
    if (blocked) return error(res, 400, blocked)

    // CLI に渡す生のセッションIDは URL から切り出さず、行の session を使う（entity.ts に逆変換を足さない）
    const rows = (await store.rows(days)).filter((r) => entityId(r.session ?? '', r.repo ?? '', String(r.ts ?? '')) === id)
    const raw = rows[rows.length - 1]?.session ?? ''
    if (!raw) return error(res, 400, 'session id missing in rows')
    const cwd = session.cwd
    try {
      if (!cwd || !(await stat(cwd)).isDirectory()) throw new Error('not a directory')
    } catch {
      return error(res, 400, `cwd が見つかりません: ${cwd || '(空)'}`)
    }
    if (run.running(id)) return error(res, 409, 'このセッションはまだ前の返信を処理中です')
    // 許可・質問を画面で答える配線。MCP の子プロセスは、ブラウザがこのサーバに来たのと同じ宛先（Host）に預ける
    const via = req.headers.host ? { url: `http://${req.headers.host}`, entity: id } : undefined
    const cmd = replyCommand(session.agent, raw, text, cwd, process.env, via)
    if (!cmd) return error(res, 400, replyBlockedReason(session) || 'unsupported agent')
    try {
      // プロセスが終わったら、そのセッションの答え待ちは deny で片付ける（もう誰も答えを取りに来ない）
      await run.start(id, cmd, () => approvals.drop(id))
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      const hint = code === 'ENOENT' ? `${cmd.bin} が見つかりません（SAI_CLAUDE_BIN / SAI_CODEX_BIN で指定できます）` : ''
      return error(res, 500, hint || (err instanceof Error ? err.message : String(err)))
    }
    const payload: ReplyResponse = { accepted: true, id, agent: session.agent, session: raw, cwd }
    return json(res, payload, 202)
  }

  /**
   * POST /api/approvals。返信中の CLI から（server/approve-mcp.ts 経由で）許可・質問を預かる。
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
    const isAsk = path === APPROVALS_PATH
    const isAnswer = path.startsWith(APPROVALS_PREFIX) && path.endsWith(ANSWER_SUFFIX)
    const isProfile = path === PROFILE_PATH
    const isProfileIcon = path === PROFILE_ICON_PATH
    const isSettings = path === SETTINGS_PATH
    const isBackfill = path === DIGEST_BACKFILL_PATH
    const method = req.method ?? 'GET'
    // 書き込みは「返信は POST」「表示名は PUT」「アイコンは PUT / DELETE」「承認の預かりと答えは POST」「自分の表示名は PUT、アイコンは PUT / DELETE」
    // 「設定は PUT」「一言の backfill は POST」だけ。それ以外は GET / HEAD のみ
    const writable =
      (method === 'POST' && (isReply || isAsk || isAnswer || isBackfill)) ||
      (method === 'PUT' && (isMeta || isProfile || isSettings)) ||
      ((method === 'PUT' || method === 'DELETE') && (isIcon || isProfileIcon))
    if (!writable && method !== 'GET' && method !== 'HEAD') return error(res, 405, 'method not allowed')
    try {
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
      if (isIcon) {
        const id = sessionIdFrom(path, ICON_SUFFIX)
        if (id === null) return error(res, 400, 'bad session id')
        if (method === 'PUT') return await putIcon(req, res, id, parseDays(q.get('days'), 90))
        if (method === 'DELETE') return await deleteIcon(req, res, id)
        return await getIcon(req, res, id, q.get('v'))
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
      if (isBackfill) {
        if (method !== 'POST') return error(res, 405, 'method not allowed')
        return await backfillDigest(req, res, Math.min(200, Math.max(1, Number.parseInt(q.get('n') ?? '20', 10) || 20)), parseDays(q.get('days'), 7))
      }

      if (path === '/api/sessions') {
        const days = parseDays(q.get('days'), 7)
        const [{ rev: sessionsRev, sessions }, me] = await Promise.all([sessionsWithMeta(days), profileNow()])
        const rev = `${sessionsRev}~${me.rev}`
        const replying = run.snapshot()
        const pendingApprovals = approvals.snapshot()
        // 既定はアーカイブ済みを除く。archived=1 でアーカイブ済みだけ。total と filters はその集合の絞り込み前から作る
        const wantArchived = q.get('archived') === '1'
        const pool = sessions.filter((s) => Boolean(s.archived) === wantArchived)
        // 配っている画面が古ければ知らせる（画面はヘッダの下にバナーを出す）。判定は 30 秒に1回
        const build_stale = await freshness.stale()
        await scanDigest(days)
        // 記録側の版は窓の中の一番新しい行から。行が変われば rev も変わるので、ここでは rev に混ぜない
        const record_version = recordVersionOf(await store.rows(days))
        const body: SessionsResponse = {
          rev: revWith(rev, replying, approvals.revKey(), build_stale, digest.revKey()),
          days,
          total: pool.length,
          sessions: withLastSummary(filterSessions(pool, q.get('repo') ?? '', q.get('agent') ?? '', q.get('date') ?? '')),
          filters: facets(pool),
          replying,
          approvals: pendingApprovals,
          build_stale,
          record_version,
          profile: me.profile,
          viewer,
        }
        return json(res, body)
      }

      if (path.startsWith(SESSIONS_PREFIX)) {
        const id = sessionIdFrom(path)
        if (id === null) return error(res, 400, 'bad session id')
        const days = parseDays(q.get('days'), 30)
        const [{ rev: sessionsRev, sessions }, me] = await Promise.all([sessionsWithMeta(days), profileNow()])
        const session = sessions.find((s) => s.id === id)
        if (!session) return error(res, 404, 'session not found in window')
        await scanDigest(days)
        const rows = digest.attach((await store.rows(days)).filter((r) => entityId(r.session ?? '', r.repo ?? '', String(r.ts ?? '')) === id))
        const replying = run.snapshot()
        const body: SessionDetailResponse = {
          rev: revWith(`${sessionsRev}~${me.rev}`, replying, approvals.revKey(), false, digest.revKey()),
          session: withLastSummary([session])[0]!,
          rows,
          replying,
          approvals: approvals.snapshot(),
          profile: me.profile,
        }
        return json(res, body)
      }

      if (path === '/api/feed') {
        const days = parseDays(q.get('days'), 3)
        const repo = q.get('repo') ?? ''
        // アーカイブ済みセッションの行は流さない（一覧から消えてもフィードに流れていたら隠した意味が無い）
        const [{ rev: sessionsRev, sessions }, me] = await Promise.all([sessionsWithMeta(days), profileNow()])
        const rev = `${sessionsRev}~${me.rev}`
        const archived = new Set(sessions.filter((s) => s.archived).map((s) => s.id))
        let rows = await store.rows(days)
        if (repo) rows = rows.filter((r) => r.repo === repo)
        if (archived.size) rows = rows.filter((r) => !archived.has(entityId(r.session ?? '', r.repo ?? '', String(r.ts ?? ''))))
        // 思考はフィードには出さないので運ばない（3秒ごとに全行を返す。セッション画面だけが使う）
        await scanDigest(days)
        rows = digest.attach(rows.map(stripThinking))
        const replying = run.snapshot()
        // rev はメタ（アーカイブ）と処理中の集合、答え待ちの承認、ビルドが古いか、一言の有無も混ぜる
        const build_stale = await freshness.stale()
        const body: FeedResponse = {
          rev: revWith(rev, replying, approvals.revKey(), build_stale, digest.revKey()),
          days,
          rows,
          replying,
          approvals: approvals.snapshot(),
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
