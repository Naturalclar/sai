// Codex の共有の app-server（daemon）を見る（#848 の 2）。端末の TUI も客になっている daemon から、スレッドの状態の通知を受ける。
// **送れる要求は `DAEMON_METHODS` の許可一覧だけ**（`turn/*` は型の上でも呼べない）。
// 許可・質問（#848 の 3）: 許可・質問を待っているスレッドだけを、呼ぶ側（`app.ts`。`.codex/` の確かめを通したあと）が `resume()` する。
// そのスレッドに届いた `DAEMON_ANSWERABLE` の要求だけを預かり、**人が画面で押した答えだけ**を返す。ほかの要求には答えない（エラーも返さない。
// 返すと TUI のダイアログまで閉じる）。TUI にも同じダイアログが出ていて、先に答えた方が効く（`serverRequest/resolved` で畳む）。
// `daemon start` はしない: ソケットが無ければ何もせず、間をあけて見直す（今の stdio の道はそのまま）。
// 本物を組むのは `main.ts` だけで、`createApp` の既定は繋がない。入切は `settings.json` の `codex_daemon`（既定は切）
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Approval, ApprovalAnswer, ApprovalMap, HoldingWhy } from '../../shared/types.ts'
import { buildCodexApproval, codexAnswerRefusal, codexAnswerResult } from './codexApproval.ts'
import type { CodexAnswerResult, CodexDecision } from './codexApproval.ts'
import { connectUnixWebSocket } from './unixWebSocket.ts'
import type { UnixWebSocket } from './unixWebSocket.ts'

/**
 * 送ってよい要求の全部。足すときは何が起きるかを確かめる。`thread/resume` は許可・質問を受けるためだけ（#848 の 3。
 * 待っているスレッドにだけ、`.codex/` の確かめのあとで投げる）。`turn/start`・`turn/steer` は足さない（届ける道は別の段）
 */
export const DAEMON_METHODS = ['initialize', 'thread/list', 'thread/loaded/list', 'thread/resume'] as const
export type DaemonMethod = (typeof DAEMON_METHODS)[number]

/** 繋いだとき・繋ぎ直したときに読む `thread/list` の 1 回の数。外のスレッドは通知が来るまで分からないまま（空きの判定は今までどおり） */
export const DAEMON_LIST_LIMIT = 200
/** daemon の許可を畳んだ（答えた・TUI で答えられた）あと、端末の画面の読み取りを抑える時間。TUI のダイアログが閉じるまでに、同じ許可を画面の文字から出し直さない */
export const DAEMON_SETTLE_MS = 5_000
/** ソケットが無い・切れたときに見直す間隔 */
export const DAEMON_RETRY_MS = 30_000
const REQUEST_TIMEOUT_MS = 8_000

/** 預かって画面に出し、答えてよいサーバからの要求の全部。ここに無いもの（追加の権限・MCP の問い合わせなど）は預からず答えない（TUI で答える） */
export const DAEMON_ANSWERABLE = ['item/commandExecution/requestApproval', 'item/fileChange/requestApproval', 'item/tool/requestUserInput'] as const

/** `answer()` の結果。SAI 自身の app-server と同じ形 */
export type DaemonAnswerResult = CodexAnswerResult

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
  /**
   * スレッドが許可・質問の待ちになったたびに（繋いだときの一覧で待っていたものも）呼ぶ。**resume 済みのスレッドでも呼ぶ**:
   * 呼ばれた側がそのたびに `.codex/` などを確かめ直し、通れば `resume()`、通らなければ `release()` する。確かめ直すまでは、
   * そのスレッドに届いた許可を画面に出さない。偽物は持たなくてよい
   */
  onWaiting?(listener: (threadId: string) => void): void
  /**
   * 許可・質問を受ける。まだならこのとき `thread/resume` する（resume 済みなら送らない）。`entity` は預かった許可を出す画面のエンティティ
   * （確かめ直しで変わっていれば、預かっている分もそちらに移す）。通れば true。偽物は持たなくてよい
   */
  resume?(threadId: string, entity: string): Promise<boolean>
  /** 確かめ直しが通らなかったスレッドを、SAI の中だけで受けるのをやめる（daemon には何も送らない。端末の画面の読み取りに戻る）。偽物は持たなくてよい */
  release?(threadId: string): void
  /** 預かっている許可・質問。偽物は持たなくてよい */
  snapshot?(): ApprovalMap
  /** 許可を畳んでから `DAEMON_SETTLE_MS` が経っていないスレッド（端末の画面の読み取りをまだ抑える）。偽物は持たなくてよい */
  settling?(): Set<string>
  getApproval?(approvalId: string): Approval | undefined
  /** 人が画面で押した答えを返す。出した候補・出した質問の答えだけ。偽物は持たなくてよい */
  answer?(approvalId: string, answer: ApprovalAnswer): DaemonAnswerResult
}

interface DaemonApproval {
  approval: Approval
  requestId: string | number
  requestKey: string
  threadId: string
  turnId: string
  method: string
  decisions: CodexDecision[]
}

const keyOf = (id: string | number) => `${typeof id}:${String(id)}`

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
  private waitingListener: ((threadId: string) => void) | null = null
  /** この接続で `thread/resume` が通ったスレッド → 画面のエンティティ */
  private readonly resumed = new Map<string, string>()
  /**
   * `thread/resume` を投げて答えを待っているスレッド → エンティティ（同じものを二重に投げない）。待っている間に届いた要求も預かる
   * （許可の途中で resume すると、resume の応答より先に要求が届きうる）
   */
  private readonly resuming = new Map<string, string>()
  /** resume 済みで、待ちになったので確かめ直している間のスレッド → エンティティ。届いた要求は預かるが画面には出さない */
  private readonly confirming = new Map<string, string>()
  /** 受けているスレッドのいまのターン（`turn/started` と、届いた要求の `turnId` から）。分からなければ無い */
  private readonly turnNow = new Map<string, string>()
  private readonly approvals = new Map<string, DaemonApproval>()
  /** ファイル変更の item（要求の `params` に差分が無いので、同じ id の `item/started` から引く）。鍵は `スレッド\nitem` */
  private readonly items = new Map<string, { item: Record<string, unknown>; turnId: unknown }>()
  private readonly now: () => number
  /** 許可を畳んだスレッド → 時刻 */
  private readonly settled = new Map<string, number>()

  constructor(opts: { socketPath: string; retryMs?: number; log?: (line: string) => void; now?: () => number }) {
    this.socketPath = opts.socketPath
    this.retryMs = opts.retryMs ?? DAEMON_RETRY_MS
    this.log = opts.log ?? (() => {})
    this.now = opts.now ?? Date.now
  }

  onWaiting(listener: (threadId: string) => void): void {
    this.waitingListener = listener
  }

  async resume(threadId: string, entity: string): Promise<boolean> {
    if (this.linkState !== 'connected' || !threadId || !entity) return false
    const known = this.resumed.get(threadId) ?? this.confirming.get(threadId)
    if (known !== undefined) {
      // 確かめ直しが通った。同じスレッドが別のリポジトリの行で続いていたら、預かっている分もこれからの許可もそちらに出す
      this.confirming.delete(threadId)
      this.resumed.set(threadId, entity)
      if (known !== entity) for (const entry of this.approvals.values()) if (entry.threadId === threadId) entry.approval = { ...entry.approval, id: entity }
      return true
    }
    if (this.resuming.has(threadId)) return false
    const generation = this.generation
    this.resuming.set(threadId, entity)
    try {
      // 上書き（cwd・model・許可の向き）は渡さない: 端末の TUI が開いているスレッドの設定を変えない。履歴も要らない
      await this.request('thread/resume', { threadId, excludeTurns: true })
      // 待っている間に閉じた（`thread/closed` が `resuming` から外した）なら、受けるスレッドにしない
      if (generation !== this.generation || !this.resuming.has(threadId)) return false
      this.resumed.set(threadId, entity)
      this.log(`受けるスレッドを足した（${this.resumed.size} 本）`)
      return true
    } catch (err) {
      if (generation !== this.generation) return false
      this.log(`thread/resume が通らなかった: ${err instanceof Error ? err.message : String(err)}`)
      // 待っている間に預かった要求は、答えても届くか分からないので出さない（端末で答える）
      for (const [approvalId, entry] of this.approvals) if (entry.threadId === threadId) this.approvals.delete(approvalId)
      return false
    } finally {
      if (generation === this.generation) this.resuming.delete(threadId)
    }
  }

  release(threadId: string): void {
    // 投げかけの resume も取り消す（応答が来ても受けるスレッドにしない）
    const had = [this.resumed.delete(threadId), this.confirming.delete(threadId), this.resuming.delete(threadId)].some(Boolean)
    this.forgetTurn(threadId, undefined)
    this.settled.delete(threadId)
    this.turnNow.delete(threadId)
    if (had) this.log('確かめ直しが通らず、受けるのをやめた')
  }

  snapshot(): ApprovalMap {
    const out: ApprovalMap = {}
    // 出すのは resume が通ったスレッドの分だけ（通る前は端末の画面の読み取りが出している。二重に出さない）
    for (const entry of this.approvals.values()) if (this.resumed.has(entry.threadId)) (out[entry.approval.id] ??= []).push(entry.approval)
    return out
  }

  settling(): Set<string> {
    const out = new Set<string>()
    const at = this.now()
    for (const [threadId, when] of this.settled) {
      if (at - when < DAEMON_SETTLE_MS) out.add(threadId)
      else this.settled.delete(threadId)
    }
    return out
  }

  getApproval(approvalId: string): Approval | undefined {
    const entry = this.approvals.get(approvalId)
    return entry && (this.resumed.has(entry.threadId) || this.confirming.has(entry.threadId)) ? entry.approval : undefined
  }

  answer(approvalId: string, answer: ApprovalAnswer): DaemonAnswerResult {
    const entry = this.approvals.get(approvalId)
    if (!entry) return { ok: false, status: 404, error: 'approval not found' }
    const ws = this.ws
    // 確かめ直している間は答えない（消さずに残し、通れば押し直せる）
    if (ws && this.confirming.has(entry.threadId)) return { ok: false, status: 409, error: '確かめ直しています。少し待ってから押し直してください' }
    // いまのターンのものでなければ断る（SAI 自身の app-server と同じ）
    const turnNow = this.turnNow.get(entry.threadId)
    if (turnNow && turnNow !== entry.turnId) {
      this.approvals.delete(approvalId)
      return { ok: false, status: 409, error: 'この質問は現在のCodex turnのものではありません' }
    }
    if (!ws || !this.resumed.has(entry.threadId)) {
      this.approvals.delete(approvalId)
      return { ok: false, status: 409, error: 'Codex の共有の app-server との接続が切れています。端末で答えてください' }
    }
    const picked = codexAnswerResult(entry.approval, entry.method, entry.decisions, answer)
    if (!picked) return { ok: false, status: 400, error: codexAnswerRefusal(entry.method) }
    try {
      ws.send(JSON.stringify({ id: entry.requestId, result: picked.result }))
    } catch (err) {
      return { ok: false, status: 409, error: err instanceof Error ? err.message : String(err) }
    }
    // 答えは 1 回だけ。同じ approval id の二重回答は以後 404。TUI で先に答えていたら daemon は何もしない（実測）
    this.approvals.delete(approvalId)
    this.settled.set(entry.threadId, this.now())
    this.log(`画面から答えた: ${entry.method}`)
    const kept = picked.decision?.kept
    return kept ? { ok: true, kept } : { ok: true }
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
    // 繋ぎ直したら `thread/resume` からやり直す（daemon を立て直すと読み込み済みのスレッドは消える。実測）。預かった要求は答えられない
    this.resumed.clear()
    this.resuming.clear()
    this.confirming.clear()
    this.turnNow.clear()
    this.approvals.clear()
    this.items.clear()
    this.settled.clear()
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
      // 繋ぐ前から待っていたスレッドも知らせる（許可の途中で `thread/resume` した客にも要求は届く。実測）
      for (const [id, state] of this.states) if (state === 'waiting') this.tellWaiting(id)
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
    const before = this.states.get(id)
    const state = threadState(status)
    if (state) this.states.set(id, state)
    else this.states.delete(id)
    // 繋ぎ終えるまでは知らせない（繋ぎ終えたところでまとめて知らせる）
    if (state === 'waiting' && before !== 'waiting' && this.linkState === 'connected') this.tellWaiting(id)
  }

  private tellWaiting(threadId: string): void {
    if (this.resuming.has(threadId) || this.confirming.has(threadId) || !this.waitingListener) return
    // resume 済みのスレッドも、確かめ直すまでは画面に出さない（最初の待ちの確かめだけで、接続の間ずっと受けない）
    const entity = this.resumed.get(threadId)
    if (entity !== undefined) {
      this.resumed.delete(threadId)
      this.confirming.set(threadId, entity)
    }
    try {
      this.waitingListener(threadId)
    } catch {
      // 知らせた先の失敗で通知の読みを止めない
    }
  }

  /** サーバからの要求。`resume()` したスレッドの、知っている形のものだけを預かる。**どれにも自分からは答えない**（人が押したときだけ `answer()`） */
  private serverRequest(id: unknown, method: string, rawParams: unknown): void {
    if (typeof id !== 'string' && typeof id !== 'number') return
    if (!(DAEMON_ANSWERABLE as readonly string[]).includes(method)) return
    const params = rawParams !== null && typeof rawParams === 'object' && !Array.isArray(rawParams) ? rawParams as Record<string, unknown> : null
    const threadId = typeof params?.threadId === 'string' ? params.threadId : ''
    const turnId = typeof params?.turnId === 'string' ? params.turnId : ''
    const itemId = typeof params?.itemId === 'string' ? params.itemId : ''
    const entity = this.resumed.get(threadId) ?? this.resuming.get(threadId) ?? this.confirming.get(threadId)
    if (!params || !entity || !turnId || !itemId) return
    const requestKey = keyOf(id)
    // 同じ要求が二度届いても（繋ぎ直し・resume のやり直し）、1 つだけ出す
    for (const entry of this.approvals.values()) if (entry.requestKey === requestKey && entry.threadId === threadId) return
    const item = this.items.get(`${threadId}\n${itemId}`)?.item
    // 差分の分からないファイル変更（許可の途中で resume したもの。要求の `params` に差分は無い）は預からない。中身を見せずに押させないため、
    // これまでどおり端末の画面の読み取りに任せる
    if (method === 'item/fileChange/requestApproval' && !(Array.isArray(item?.changes) && item.changes.length > 0)) return
    const built = buildCodexApproval({ entity, method, params, itemId, now: this.now(), ...(item ? { item } : {}) })
    // 押せる候補が 1 つも無いもの（範囲を書けない規則の追加だけ など）も預からない。画面の読み取りなら答えられることがある
    if (!built || built.approval.answerable === false) return
    this.turnNow.set(threadId, turnId)
    this.approvals.set(built.approval.approval_id, { approval: built.approval, requestId: id, requestKey, threadId, turnId, method, decisions: built.decisions })
    // resume 済みのスレッドに届いた要求は、状態の通知を待たずにここで確かめ直しに回す（通知より先に届くと、確かめ直す前に出てしまう）
    if (this.resumed.has(threadId)) this.tellWaiting(threadId)
  }

  private forgetTurn(threadId: string, turnId: unknown): void {
    for (const [approvalId, entry] of this.approvals) if (entry.threadId === threadId && (typeof turnId !== 'string' || entry.turnId === turnId)) this.approvals.delete(approvalId)
    for (const [key, entry] of this.items) if (key.startsWith(`${threadId}\n`) && (typeof turnId !== 'string' || entry.turnId === turnId)) this.items.delete(key)
  }

  private receive(text: string): void {
    let m: { id?: unknown; method?: unknown; params?: Record<string, unknown>; result?: unknown; error?: unknown } | null
    try {
      m = JSON.parse(text)
    } catch {
      return
    }
    // 形の違うものは読み捨てる
    if (!m || typeof m !== 'object') return
    // サーバからの要求（id と method の両方）。預かるだけで、ここでは答えない
    if (m.id !== undefined && m.method !== undefined) {
      if (typeof m.method === 'string') this.serverRequest(m.id, m.method, m.params)
      return
    }
    if (typeof m.id === 'number') {
      const p = this.pending.get(m.id)
      if (!p) return
      this.pending.delete(m.id)
      clearTimeout(p.timer)
      // `error` の形を信じない（文字列にできない形で投げると、待っている要求が返らないまま残る。#859 のレビュー）
      if (m.error !== undefined && m.error !== null) p.reject(new Error(errorMessage(m.error)))
      else p.resolve(m.result)
      return
    }
    const params = m.params !== null && typeof m.params === 'object' && !Array.isArray(m.params) ? m.params : undefined
    if (m.method === 'thread/status/changed') this.heard(params?.threadId, params?.status)
    else if (m.method === 'thread/started') {
      const t = params?.thread as { id?: unknown; status?: unknown } | undefined
      this.heard(t?.id, t?.status)
    } else if (m.method === 'serverRequest/resolved') {
      // TUI・ほかの客・SAI のどこで答えても届く。畳む
      const rid = params?.requestId
      if (typeof rid !== 'string' && typeof rid !== 'number') return
      const key = keyOf(rid)
      const threadId = typeof params?.threadId === 'string' ? params.threadId : ''
      for (const [approvalId, entry] of this.approvals) {
        if (entry.requestKey !== key || (threadId && entry.threadId !== threadId)) continue
        this.approvals.delete(approvalId)
        if (this.resumed.has(entry.threadId)) this.settled.set(entry.threadId, this.now())
      }
    } else if (m.method === 'item/started') {
      const threadId = params?.threadId
      const item = params?.item as Record<string, unknown> | undefined
      if (typeof threadId === 'string' && (this.resumed.has(threadId) || this.resuming.has(threadId) || this.confirming.has(threadId)) && item?.type === 'fileChange' && typeof item.id === 'string') this.items.set(`${threadId}\n${item.id}`, { item, turnId: params?.turnId })
    } else if (m.method === 'turn/started') {
      const threadId = params?.threadId
      const turnId = (params?.turn as { id?: unknown } | undefined)?.id
      if (typeof threadId === 'string' && typeof turnId === 'string' && (this.resumed.has(threadId) || this.confirming.has(threadId))) this.turnNow.set(threadId, turnId)
    } else if (m.method === 'turn/completed') {
      const threadId = params?.threadId
      if (typeof threadId === 'string') this.forgetTurn(threadId, (params?.turn as { id?: unknown } | undefined)?.id)
    } else if (m.method === 'thread/closed') {
      const threadId = params?.threadId
      if (typeof threadId === 'string') {
        this.forgetTurn(threadId, undefined)
        this.resumed.delete(threadId)
        this.resuming.delete(threadId)
        this.confirming.delete(threadId)
        this.turnNow.delete(threadId)
      }
    }
  }
}

/** 応答の `error` から、文字列にできる理由だけを取る。どんな形でも投げない */
export function errorMessage(error: unknown): string {
  const message = error !== null && typeof error === 'object' ? (error as { message?: unknown }).message : error
  return typeof message === 'string' && message ? message : 'error'
}
