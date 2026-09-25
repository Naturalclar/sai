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
import { DEFAULT_PORT, parsePort } from '../shared/port.ts'
import { createApp } from './app.ts'
import { jevFromEnv } from './approvals/jev.ts'
import { RealTmux, realPs } from './reply/terminal.ts'
import { FeedStore } from './rows/store.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
export const DIST_DIR = resolve(HERE, '..', 'web', 'dist')
const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '::1'])

/** C-c のあと、アイドルでない接続（長く待たせている返事）も切るまでの猶予 */
export const CLOSE_ALL_MS = 1_000
/** それでも抜けられないときに諦めて終わるまで */
export const FORCE_EXIT_MS = 3_000

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
        port: { type: 'string', default: env.SAI_PORT ?? String(DEFAULT_PORT) },
        host: { type: 'string', default: '127.0.0.1' },
        'feed-dir': { type: 'string', default: env.AGENT_FEED_DIR ?? join(homedir(), '.agent-feed') },
      },
      allowPositionals: false,
    }))
  } catch (err) {
    return { ok: false, error: `${err instanceof Error ? err.message : String(err)}\n${USAGE}` }
  }
  if (!LOCAL_HOSTS.has(values.host)) return { ok: false, error: `refusing to bind to ${values.host}: SAI is local-only` }
  // 判定は shared/port.ts に 1 つだけ置く（Vite の proxy 先も同じ規則で決める。#146）
  const port = parsePort(values.port)
  if (port === null) {
    return { ok: false, error: `invalid port: ${values.port}（1〜65535 の整数。--port か SAI_PORT で指定する）` }
  }
  return { ok: true, options: { port, host: values.host, feedDir: resolve(expandHome(values['feed-dir'])) } }
}

/** `shutdown()` が要る口だけ（テストから偽物を渡せるように、`http.Server` そのものは要求しない） */
export interface Closable {
  close(cb?: () => void): unknown
  closeIdleConnections(): void
  closeAllConnections(): void
}

export interface ShutdownOptions {
  exit?: (code: number) => void
  /**
   * 終わる前に、SAI が起こした長寿命の子を落とす（#457。`createApp()` の `dispose`）。
   * **1 回目の C-c の頭で 1 度だけ**呼ぶ（接続が閉じるのを待つ前。`FORCE_EXIT_MS` で諦めて終わる筋でも必ず通るように）
   */
  onStop?: () => void
  closeAllMs?: number
  forceExitMs?: number
}

/**
 * C-c / SIGTERM で必ず終わるようにする（#296）。
 *
 * `server.close()` は**新しい接続の受け付けをやめるだけ**で、コールバックは全部の接続が閉じてから呼ばれる。
 * SAI は開きっぱなしのタブ（PC・携帯）が 3 秒ごとにポーリングするので、**タブが 1 枚あるだけで抜けられない**
 * （listen だけ消えるので、外からは「止まった」ように見えるのに node は生きている。`/sync-main` が打った
 * 起動コマンドはそのまま foreground の pnpm に飲まれ、SAI が止まったままになっていた）。
 *
 * そこで 3 段にする: アイドルな接続はすぐ閉じ（`closeIdleConnections`）、残るものは `CLOSE_ALL_MS` 後に切り
 * （`closeAllConnections`）、それでも抜けなければ `FORCE_EXIT_MS` で諦めて終わる。**タイマーは `unref()` する**
 * ので、先に抜けられればこれが終了を遅らせることはない。
 *
 * **2 回目の C-c はすぐ終わる**（前は同じ `close` を呼ぶだけで、連打しても何も起きなかった）。
 * 返信の子（`claude -p --resume` など）は別の pgid で detached なので巻き込まない。次のサーバが
 * `replying.json` から引き取る。
 */
export function shutdown(server: Closable, opts: ShutdownOptions = {}): () => void {
  const exit = opts.exit ?? ((code: number) => process.exit(code))
  const closeAllMs = opts.closeAllMs ?? CLOSE_ALL_MS
  const forceExitMs = opts.forceExitMs ?? FORCE_EXIT_MS
  let stopping = false
  return () => {
    if (stopping) return exit(0)
    stopping = true
    try {
      opts.onStop?.()
    } catch {
      // 子を落とせなくても SAI 自身は必ず終わる（#296）
    }
    server.close(() => exit(0))
    server.closeIdleConnections()
    setTimeout(() => server.closeAllConnections(), closeAllMs).unref()
    setTimeout(() => exit(0), forceExitMs).unref()
  }
}

export function main(argv: string[]): void {
  const parsed = parseOptions(argv)
  if (!parsed.ok) {
    console.error(parsed.error)
    process.exit(2)
  }
  const { port, host, feedDir } = parsed.options
  // 端末の口（8 つ目）だけ既定を上書きして、許可の確率を聞く Jev の口を渡す（#491）。**環境の JEV_API_KEY から組むのはここだけ**
  // （createApp の既定は「送らない」。テストが本物の Jev に送らないように）。間の引数は undefined で既定のまま
  const app = createApp(new FeedStore(feedDir), DIST_DIR, undefined, undefined, undefined, undefined, undefined, {
    tmux: new RealTmux(),
    ps: realPs,
    jev: jevFromEnv(),
  })
  const server = createServer((req, res) => {
    void app(req, res)
  })
  server.listen(port, host, () => {
    console.error(`SAI  http://${host}:${port}/   feed=${feedDir}`)
  })
  const stop = shutdown(server, { onStop: app.dispose })
  process.on('SIGINT', stop)
  process.on('SIGTERM', stop)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2))
}
