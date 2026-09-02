#!/usr/bin/env node
// SAI: agent-feed の JSONL をローカルで眺めるための最小 HTTP サーバ。
//
// 127.0.0.1 にしか bind しない。デプロイもホスティングもしない。
// 集計（セッション単位へのまとめ）はここでやる。ブラウザに生の JSONL を
// 全部投げて JS でまとめると、日が経つほど重くなるため。
//
//   pnpm start                       # http://127.0.0.1:8787/
//   pnpm start --port 9000 --feed-dir ~/.agent-feed
//
// 引数の検査は parseOptions() にまとめてあり、おかしければ1行で断って exit 2（スタックトレースは出さない）。
// pnpm の癖で付く先頭の `--`（`pnpm start -- --port 9000`）は落とす。
//
// エンドポイント:
//   GET /                                  ビューア（web/dist/。`pnpm build` の成果物）
//   GET /api/sessions?days=7&repo=&agent=&date=
//   GET /api/sessions/<id>?days=30
//   GET /api/feed?days=3&repo=
import { createServer } from 'node:http'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { fileURLToPath } from 'node:url'
import { createApp } from './app.ts'
import { FeedStore } from './store.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
export const DIST_DIR = resolve(HERE, '..', 'web', 'dist')
const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '::1'])

export function expandHome(p: string): string {
  return p.startsWith('~/') || p === '~' ? join(homedir(), p.slice(1)) : p
}

export interface Options {
  port: number
  host: string
  feedDir: string
}

const USAGE = 'usage: pnpm start [--port 8787] [--host 127.0.0.1] [--feed-dir ~/.agent-feed]'

/**
 * 引数と環境変数から起動の設定を作る。おかしければ理由を返し、呼び出し側が1行で断る。
 * - 先頭の `--` は落とす（pnpm 10 は `pnpm start -- --port 9000` の `--` をそのまま渡す）
 * - 知らない引数・余った引数は parseArgs の例外を文にして返す（スタックトレースにしない）
 * - port は 1〜65535 の整数だけ。`--port abc` も `SAI_PORT=abc` も同じ扱い
 * - host は 127.0.0.1 / localhost / ::1 だけ。中身は作業内容そのものなので外に出さない
 */
export function parseOptions(argv: string[], env: NodeJS.ProcessEnv = process.env): { ok: true; options: Options } | { ok: false; error: string } {
  const args = argv[0] === '--' ? argv.slice(1) : argv
  let values: { port: string; host: string; 'feed-dir': string }
  try {
    ;({ values } = parseArgs({
      args,
      options: {
        port: { type: 'string', default: env.SAI_PORT ?? '8787' },
        host: { type: 'string', default: '127.0.0.1' },
        'feed-dir': { type: 'string', default: env.AGENT_FEED_DIR ?? join(homedir(), '.agent-feed') },
      },
      allowPositionals: false,
    }))
  } catch (err) {
    return { ok: false, error: `${err instanceof Error ? err.message : String(err)}\n${USAGE}` }
  }
  if (!LOCAL_HOSTS.has(values.host)) return { ok: false, error: `refusing to bind to ${values.host}: SAI is local-only` }
  const port = /^\d+$/.test(values.port) ? Number.parseInt(values.port, 10) : Number.NaN
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return { ok: false, error: `invalid port: ${values.port}（1〜65535 の整数。--port か SAI_PORT で指定する）` }
  }
  return { ok: true, options: { port, host: values.host, feedDir: resolve(expandHome(values['feed-dir'])) } }
}

export function main(argv: string[]): void {
  const parsed = parseOptions(argv)
  if (!parsed.ok) {
    console.error(parsed.error)
    process.exit(2)
  }
  const { port, host, feedDir } = parsed.options
  const app = createApp(new FeedStore(feedDir), DIST_DIR)
  const server = createServer((req, res) => {
    void app(req, res)
  })
  server.listen(port, host, () => {
    console.error(`SAI  http://${host}:${port}/   feed=${feedDir}`)
  })
  const stop = () => server.close(() => process.exit(0))
  process.on('SIGINT', stop)
  process.on('SIGTERM', stop)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2))
}
