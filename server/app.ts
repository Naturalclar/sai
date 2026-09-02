// ルーティング。main.ts が node:http に載せ、テストは createApp() を直接叩く。
import { readFile, stat } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { extname, join, resolve, sep } from 'node:path'
import { normalizeMeta } from '../shared/meta.ts'
import { replyBlockedReason } from '../shared/reply.ts'
import type {
  FeedResponse,
  ReplyRequest,
  ReplyResponse,
  SessionDetailResponse,
  SessionMetaResponse,
  SessionsResponse,
  SessionSummary,
} from '../shared/types.ts'
import { entityId, facets, filterSessions } from './aggregate.ts'
import { META_FILE, MetaStore } from './meta.ts'
import { ProcessRunner, replyCommand } from './runner.ts'
import type { Runner } from './runner.ts'
import { rev as revOf } from './store.ts'
import type { FeedStore } from './store.ts'

export const MAX_DAYS = 366
/** 返信 body の上限。指示文なので十分 */
export const MAX_REPLY_BYTES = 64 * 1024

/** 表示名・アイコンの body の上限。名前と絵文字1つなので十分 */
export const MAX_META_BYTES = 4 * 1024

const SESSIONS_PREFIX = '/api/sessions/'
const REPLY_SUFFIX = '/reply'
const META_SUFFIX = '/meta'

/**
 * 別オリジンからの POST か。ブラウザからコマンドが走るので、ローカルで開いている別サイトからの
 * CSRF でエージェントを走らせない。ブラウザは POST に Origin か Sec-Fetch-Site を必ず付ける。
 * どちらも無いのは curl などブラウザ以外なので通す（そもそもコマンドを直接叩ける相手）。
 */
export function isCrossOrigin(req: IncomingMessage): boolean {
  const site = req.headers['sec-fetch-site']
  if (typeof site === 'string' && site !== 'same-origin' && site !== 'none') return true
  const origin = req.headers.origin
  if (typeof origin === 'string' && origin !== `http://${req.headers.host ?? ''}`) return true
  return false
}

async function readJson(req: IncomingMessage, limit: number): Promise<unknown> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buf = chunk as Buffer
    size += buf.length
    if (size > limit) throw new Error('body too large')
    chunks.push(buf)
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf-8') || 'null')
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

export type Handler = (req: IncomingMessage, res: ServerResponse) => Promise<void>

export function createApp(store: FeedStore, distDir: string, runner?: Runner): Handler {
  const distRoot = resolve(distDir)
  const run: Runner = runner ?? new ProcessRunner(join(store.directory, 'reply.log'))
  const metaStore = new MetaStore(join(store.directory, META_FILE))

  /**
   * 集計済みのセッションに表示名・アイコンを載せる。store のキャッシュ配列は触らず新しい配列を返す。
   * rev にメタファイルの状態も混ぜるので、名前を付けただけでも画面のポーリングが拾う
   */
  const sessionsWithMeta = async (days: number): Promise<{ rev: string; sessions: SessionSummary[] }> => {
    const [{ rev, sessions }, meta] = await Promise.all([store.sessions(days), metaStore.all()])
    if (!meta.rev) return { rev, sessions }
    return {
      rev: `${rev}-${meta.rev}`,
      sessions: sessions.map((s) => (meta.entries[s.id] ? { ...s, meta: meta.entries[s.id] } : s)),
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
    const cmd = replyCommand(session.agent, raw, text, cwd)
    if (!cmd) return error(res, 400, replyBlockedReason(session) || 'unsupported agent')
    try {
      await run.start(id, cmd)
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      const hint = code === 'ENOENT' ? `${cmd.bin} が見つかりません（SAI_CLAUDE_BIN / SAI_CODEX_BIN で指定できます）` : ''
      return error(res, 500, hint || (err instanceof Error ? err.message : String(err)))
    }
    const payload: ReplyResponse = { accepted: true, id, agent: session.agent, session: raw, cwd }
    return json(res, payload, 202)
  }

  /** PUT /api/sessions/<id>/meta。表示名・アイコンを置き換える（空なら消す）。窓の中に無いセッションには付けない */
  const putMeta = async (req: IncomingMessage, res: ServerResponse, id: string, days: number) => {
    if (isCrossOrigin(req)) return error(res, 403, 'cross-origin request rejected')
    let body: unknown
    try {
      body = await readJson(req, MAX_META_BYTES)
    } catch (err) {
      return error(res, 400, err instanceof Error ? err.message : 'bad body')
    }
    const { meta, error: reason } = normalizeMeta(body)
    if (reason) return error(res, 400, reason)
    const { sessions } = await store.sessions(days)
    if (!sessions.some((s) => s.id === id)) return error(res, 404, 'session not found in window')
    const saved = await metaStore.set(id, meta)
    const payload: SessionMetaResponse = { id, meta: saved ?? {} }
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
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    const q = url.searchParams
    const path = url.pathname
    const isReply = path.startsWith(SESSIONS_PREFIX) && path.endsWith(REPLY_SUFFIX)
    const isMeta = path.startsWith(SESSIONS_PREFIX) && path.endsWith(META_SUFFIX)
    const method = req.method ?? 'GET'
    // 書き込みは「返信は POST」「表示名は PUT」の2つだけ。それ以外は GET / HEAD のみ
    const writable = (method === 'POST' && isReply) || (method === 'PUT' && isMeta)
    if (!writable && method !== 'GET' && method !== 'HEAD') return error(res, 405, 'method not allowed')
    try {
      if (isReply) {
        if (method !== 'POST') return error(res, 405, 'method not allowed')
        const id = decodeURIComponent(path.slice(SESSIONS_PREFIX.length, -REPLY_SUFFIX.length))
        if (!id || id.includes('/')) return error(res, 400, 'bad session id')
        return await reply(req, res, id, parseDays(q.get('days'), 90))
      }
      if (path.startsWith('/api/')) {
        // 画面はポーリングのついでにこれを見て、別ターミナルで pnpm build されたらリロードする
        const build = await buildId()
        if (build) res.setHeader('X-SAI-Build', build)
      }
      if (isMeta) {
        const id = decodeURIComponent(path.slice(SESSIONS_PREFIX.length, -META_SUFFIX.length))
        if (!id || id.includes('/')) return error(res, 400, 'bad session id')
        if (method === 'PUT') return await putMeta(req, res, id, parseDays(q.get('days'), 90))
        const payload: SessionMetaResponse = { id, meta: (await metaStore.get(id)) ?? {} }
        return json(res, payload)
      }
      if (path === '/' || path === '/index.html') return await sendStatic(res, 'index.html')
      if (path.startsWith('/assets/')) return await sendStatic(res, path.slice(1))
      if (path === '/favicon.ico') return send(res, 204, '', 'image/x-icon')
      if (path === '/api/health') return json(res, { ok: true })

      if (path === '/api/sessions') {
        const days = parseDays(q.get('days'), 7)
        const { rev, sessions } = await sessionsWithMeta(days)
        const body: SessionsResponse = {
          rev,
          days,
          total: sessions.length,
          sessions: filterSessions(sessions, q.get('repo') ?? '', q.get('agent') ?? '', q.get('date') ?? ''),
          filters: facets(sessions),
        }
        return json(res, body)
      }

      if (path.startsWith(SESSIONS_PREFIX)) {
        const id = decodeURIComponent(path.slice(SESSIONS_PREFIX.length)).replace(/\/+$/, '')
        if (!id || id.includes('/')) return error(res, 400, 'bad session id')
        const days = parseDays(q.get('days'), 30)
        const { rev, sessions } = await sessionsWithMeta(days)
        const session = sessions.find((s) => s.id === id)
        if (!session) return error(res, 404, 'session not found in window')
        const rows = (await store.rows(days)).filter((r) => entityId(r.session ?? '', r.repo ?? '', String(r.ts ?? '')) === id)
        const body: SessionDetailResponse = { rev, session, rows }
        return json(res, body)
      }

      if (path === '/api/feed') {
        const days = parseDays(q.get('days'), 3)
        const repo = q.get('repo') ?? ''
        let rows = await store.rows(days)
        if (repo) rows = rows.filter((r) => r.repo === repo)
        const body: FeedResponse = { rev: revOf(await store.signature(days)), days, rows }
        return json(res, body)
      }

      return error(res, 404, 'not found')
    } catch (err) {
      // 表示側が壊れても記録側には影響しない
      return error(res, 500, err instanceof Error ? `${err.name}: ${err.message}` : String(err))
    }
  }
}
