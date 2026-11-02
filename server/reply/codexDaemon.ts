// Codex の共有の app-server（daemon）を**読むだけ**で見る（#848 の 2）。端末の TUI も客になっている daemon から、スレッドの状態の通知を受ける。
// **送れる要求は `DAEMON_METHODS` の許可一覧だけ**（`turn/*`・`thread/resume` は型の上でも呼べない）。サーバからの要求には答えない。
// `daemon start` はしない: ソケットが無ければ何もせず、間をあけて見直す（今の stdio の道はそのまま）。
// 本物を組むのは `main.ts` だけで、`createApp` の既定は繋がない。入切は `settings.json` の `codex_daemon`（既定は切）
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { HoldingWhy } from '../../shared/types.ts'
import { connectUnixWebSocket } from './unixWebSocket.ts'
import type { UnixWebSocket } from './unixWebSocket.ts'

/** 送ってよい要求の全部。足すときは「読むだけか」を確かめる（書く要求は別の段の PR で別に足す） */
export const DAEMON_METHODS = ['initialize', 'thread/list', 'thread/loaded/list'] as const
export type DaemonMethod = (typeof DAEMON_METHODS)[number]

/** 繋いだとき・繋ぎ直したときに読む `thread/list` の 1 回の数。外のスレッドは通知が来るまで分からないまま（空きの判定は今までどおり） */
export const DAEMON_LIST_LIMIT = 200
/** ソケットが無い・切れたときに見直す間隔 */
export const DAEMON_RETRY_MS = 30_000
const REQUEST_TIMEOUT_MS = 8_000

/** daemon から見たスレッドの状態。`idle` は「空き」の証拠にしない（`daemonOccupied()`） */
export type DaemonThreadState = 'idle' | 'active' | 'waiting'

/** `off` = 切、`no_socket` = 入だがソケットが無い、`failed` = 繋げなかった・切れた、`connected` = 繋がっている */
export type DaemonLink = 'off' | 'no_socket' | 'failed' | 'connected'

export interface CodexDaemonWatch {
  /** 設定の入切。切なら切断して、覚えた状態を捨てる */
  setEnabled(on: boolean): void
  link(): DaemonLink
  /** 分からないスレッドは undefined */
  state(threadId: string): DaemonThreadState | undefined
  stop(): void
}

/** daemon の状態から言える「空きでない理由」。**言えるのは空きでないときだけ**（`idle`・分からないは空文字で、今までの判定に任せる） */
export function daemonOccupied(state: DaemonThreadState | undefined): HoldingWhy | '' {
  return state === 'waiting' ? 'waiting' : state === 'active' ? 'busy' : ''
}

/** 食い違いの記録（`codex-daemon.log`）。ファイルの名前はここ 1 か所 */
export const CODEX_DAEMON_LOG = 'codex-daemon.log'

/** `daemon_only` = daemon は動いていると言うが今の判定は空き、`sai_only` = 今の判定は動いていると言うが daemon は `idle` */
export type DaemonGap = 'daemon_only' | 'sai_only' | ''

/** 今の判定（`holdingsOf()` の `occupied`）と daemon の状態の食い違い。古い道を消してよいかを数える材料。分からないときは数えない */
export function daemonGap(known: HoldingWhy | '', seen: DaemonThreadState | undefined): DaemonGap {
  if (!seen) return ''
  if (seen !== 'idle') return known ? '' : 'daemon_only'
  return known === 'busy' || known === 'terminal' || known === 'waiting' ? 'sai_only' : ''
}

/**
 * `ThreadStatus` を読む。知らない形は undefined（分からない）。`notLoaded` も分からない側: daemon の外の app-server（SAI の stdio など）で
 * 回っているスレッドもこの形に見えうるので、`idle` と同じにすると食い違いの数（`daemonGap()`）が濁る
 */
export function threadState(status: unknown): DaemonThreadState | undefined {
  const s = status as { type?: unknown; activeFlags?: unknown } | null | undefined
  if (s?.type === 'idle') return 'idle'
  if (s?.type !== 'active') return undefined
  return Array.isArray(s.activeFlags) && s.activeFlags.length > 0 ? 'waiting' : 'active'
}

/** 本物のソケットの場所（`$CODEX_HOME` が無ければ `~/.codex`）。`~/.codex` は読むだけで、ここには書かない */
export function daemonSocketPath(env: NodeJS.ProcessEnv = process.env, home = homedir()): string {
  return join(env.CODEX_HOME || join(home, '.codex'), 'app-server-control', 'app-server-control.sock')
}

interface Pending {
  resolve: (value: unknown) => void
  reject: (err: Error) => void
  timer: NodeJS.Timeout
}

export class CodexDaemonClient implements CodexDaemonWatch {
  private readonly socketPath: string
  private readonly retryMs: number
  private readonly log: (line: string) => void
  private enabled = false
  private linkState: DaemonLink = 'off'
  private ws: UnixWebSocket | null = null
  /** 切り替えをまたいだ古い接続の後始末を無視するための番号 */
  private generation = 0
  private retry: NodeJS.Timeout | null = null
  private nextId = 0
  private readonly pending = new Map<number, Pending>()
  private readonly states = new Map<string, DaemonThreadState>()
  /** `thread/list` を待つ間に通知が届いたスレッド。読み終えたら null */
  private notified: Set<string> | null = null

  constructor(opts: { socketPath: string; retryMs?: number; log?: (line: string) => void }) {
    this.socketPath = opts.socketPath
    this.retryMs = opts.retryMs ?? DAEMON_RETRY_MS
    this.log = opts.log ?? (() => {})
  }

  setEnabled(on: boolean): void {
    if (on === this.enabled) return
    this.enabled = on
    if (on) void this.open()
    else this.shut('off')
  }

  link(): DaemonLink {
    return this.linkState
  }

  state(threadId: string): DaemonThreadState | undefined {
    return this.states.get(threadId)
  }

  stop(): void {
    this.setEnabled(false)
  }

  private shut(link: DaemonLink): void {
    this.generation++
    if (this.retry) clearTimeout(this.retry)
    this.retry = null
    this.ws?.close()
    this.ws = null
    this.linkState = link
    // 切れている間の状態は分からない（古い `active` を残すと、ずっと空きでないままになる）
    this.states.clear()
    this.notified = null
    for (const p of this.pending.values()) {
      clearTimeout(p.timer)
      p.reject(new Error('disconnected'))
    }
    this.pending.clear()
  }

  private later(): void {
    if (!this.enabled || this.retry) return
    this.retry = setTimeout(() => {
      this.retry = null
      void this.open()
    }, this.retryMs)
    this.retry.unref?.()
  }

  private async open(): Promise<void> {
    if (!this.enabled || this.ws) return
    // **ここで daemon を起こさない**（無ければ今の道のまま）
    if (!existsSync(this.socketPath)) {
      this.linkState = 'no_socket'
      return this.later()
    }
    const generation = ++this.generation
    const drop = (link: DaemonLink, why: string) => {
      if (generation !== this.generation) return
      this.log(`切れた: ${why}`)
      this.shut(link)
      this.later()
    }
    try {
      const ws = await connectUnixWebSocket(this.socketPath, { text: (text) => this.receive(text), close: () => drop('failed', 'ソケットが閉じた') })
      if (generation !== this.generation) return ws.close()
      this.ws = ws
      await this.request('initialize', { clientInfo: { name: 'sai', title: 'SAI', version: '0.2.0' }, capabilities: { experimentalApi: true, requestAttestation: false } })
      ws.send(JSON.stringify({ method: 'initialized' }))
      this.notified = new Set()
      const list = (await this.request('thread/list', { limit: DAEMON_LIST_LIMIT })) as { data?: { id?: unknown; status?: unknown }[] }
      // 待っている間に通知が届いたスレッドは、通知の方が新しいので上書きしない（分からないになった通知も）
      for (const t of list.data ?? []) if (typeof t.id === 'string' && !this.notified.has(t.id)) this.note(t.id, t.status)
      this.notified = null
      const loaded = (await this.request('thread/loaded/list', {})) as { data?: unknown[] }
      if (generation !== this.generation) return
      this.linkState = 'connected'
      this.log(`繋いだ: スレッド ${list.data?.length ?? 0} 本、読み込み済み ${loaded.data?.length ?? 0} 本`)
    } catch (err) {
      drop('failed', err instanceof Error ? err.message : String(err))
    }
  }

  private request(method: DaemonMethod, params: unknown): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const ws = this.ws
      if (!ws) return reject(new Error('not connected'))
      const id = ++this.nextId
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`${method} timed out`))
      }, REQUEST_TIMEOUT_MS)
      this.pending.set(id, { resolve, reject, timer })
      ws.send(JSON.stringify({ id, method, params }))
    })
  }

  private heard(id: unknown, status: unknown): void {
    if (typeof id === 'string') this.notified?.add(id)
    this.note(id, status)
  }

  private note(id: unknown, status: unknown): void {
    if (typeof id !== 'string') return
    const state = threadState(status)
    if (state) this.states.set(id, state)
    else this.states.delete(id)
  }

  private receive(text: string): void {
    let m: { id?: unknown; method?: unknown; params?: Record<string, unknown>; result?: unknown; error?: { message?: unknown } } | null
    try {
      m = JSON.parse(text)
    } catch {
      return
    }
    // 形の違うものは読み捨てる
    if (!m || typeof m !== 'object') return
    // **サーバからの要求（id と method の両方）には答えない**。読むだけの客なので、許可・質問を受け取らない
    if (m.id !== undefined && m.method !== undefined) return
    if (typeof m.id === 'number') {
      const p = this.pending.get(m.id)
      if (!p) return
      this.pending.delete(m.id)
      clearTimeout(p.timer)
      if (m.error) p.reject(new Error(String(m.error.message ?? 'error')))
      else p.resolve(m.result)
      return
    }
    if (m.method === 'thread/status/changed') this.heard(m.params?.threadId, m.params?.status)
    else if (m.method === 'thread/started') {
      const t = m.params?.thread as { id?: unknown; status?: unknown } | undefined
      this.heard(t?.id, t?.status)
    }
  }
}
