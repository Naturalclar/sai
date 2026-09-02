#!/usr/bin/env node
// SAI: agent-feed の JSONL をローカルで眺めるための最小 HTTP サーバ。
//
// 127.0.0.1 にしか bind しない。デプロイもホスティングもしない。
// 集計（セッション単位へのまとめ）はここでやる。ブラウザに生の JSONL を
// 全部投げて JS でまとめると、日が経つほど重くなるため。
//
//   pnpm start                       # http://127.0.0.1:8787/
//   pnpm start -- --port 9000 --feed-dir ~/.agent-feed
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

export function main(argv: string[]): void {
  const { values } = parseArgs({
    args: argv,
    options: {
      port: { type: 'string', default: process.env.SAI_PORT ?? '8787' },
      host: { type: 'string', default: '127.0.0.1' },
      'feed-dir': { type: 'string', default: process.env.AGENT_FEED_DIR ?? join(homedir(), '.agent-feed') },
    },
  })
  const host = values.host
  if (!LOCAL_HOSTS.has(host)) {
    // 中身は作業内容そのものなので外に出さない
    console.error(`refusing to bind to ${host}: SAI is local-only`)
    process.exit(2)
  }
  const port = Number.parseInt(values.port, 10)
  const feedDir = resolve(expandHome(values['feed-dir']))
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
