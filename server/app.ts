// ルーティング。main.ts が node:http に載せ、テストは createApp() を直接叩く。
import { readFile } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { extname, resolve, sep } from 'node:path'
import type { FeedResponse, SessionDetailResponse, SessionsResponse } from '../shared/types.ts'
import { facets, filterSessions } from './aggregate.ts'
import { rev as revOf } from './store.ts'
import type { FeedStore } from './store.ts'

export const MAX_DAYS = 366

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

export function createApp(store: FeedStore, distDir: string): Handler {
  const distRoot = resolve(distDir)

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

  return async (req, res) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return error(res, 405, 'method not allowed')
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    const q = url.searchParams
    const path = url.pathname
    try {
      if (path === '/' || path === '/index.html') return await sendStatic(res, 'index.html')
      if (path.startsWith('/assets/')) return await sendStatic(res, path.slice(1))
      if (path === '/favicon.ico') return send(res, 204, '', 'image/x-icon')
      if (path === '/api/health') return json(res, { ok: true })

      if (path === '/api/sessions') {
        const days = parseDays(q.get('days'), 7)
        const { rev, sessions } = await store.sessions(days)
        const body: SessionsResponse = {
          rev,
          days,
          total: sessions.length,
          sessions: filterSessions(sessions, q.get('repo') ?? '', q.get('agent') ?? '', q.get('date') ?? ''),
          filters: facets(sessions),
        }
        return json(res, body)
      }

      if (path.startsWith('/api/sessions/')) {
        const id = decodeURIComponent(path.slice('/api/sessions/'.length)).replace(/\/+$/, '')
        if (!id || id.includes('/')) return error(res, 400, 'bad session id')
        const days = parseDays(q.get('days'), 30)
        const { rev, sessions } = await store.sessions(days)
        const session = sessions.find((s) => s.id === id)
        if (!session) return error(res, 404, 'session not found in window')
        const rows = (await store.rows(days)).filter((r) => r.session === id)
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
