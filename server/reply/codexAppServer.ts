// SAIから送ったCodexのターンをapp-serverで管理する。
// 通常起動のTUIはこの接続の所有物ではないので、従来どおりtmux / queueへ任せる。
import { randomBytes } from 'node:crypto'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createInterface } from 'node:readline'
import type { Approval, ApprovalAnswer, ApprovalMap, ReplyingMap } from '../../shared/types.ts'
import { childEnv, splitArgs } from './runner.ts'

type RpcId = string | number
type JsonObject = Record<string, unknown>

interface RpcMessage extends JsonObject {
  id?: RpcId
  method?: string
  params?: unknown
  result?: unknown
  error?: unknown
}

export interface CodexConnection {
  send(message: RpcMessage): void
  onMessage(listener: (message: RpcMessage) => void): void
  onClose(listener: (error?: Error) => void): void
  close(): void
}

export type CodexConnector = () => Promise<CodexConnection>

export interface CodexTurnInput {
  id: string
  threadId: string
  text: string
  cwd: string
  model?: string
  attachments?: readonly string[]
}

export type CodexAnswerResult =
  | { ok: true }
  | { ok: false; status: 400 | 404 | 409; error: string }

/** app.tsが使う境界。テストではプロセスを立てない偽物へ差し替える */
export interface CodexApp {
  running(id: string): boolean
  replying(): ReplyingMap
  snapshot(): ApprovalMap
  getApproval(approvalId: string): Approval | undefined
  start(input: CodexTurnInput): Promise<void>
  answer(approvalId: string, answer: ApprovalAnswer): CodexAnswerResult
  /**
   * SAI から起動したターンが終わった（完了・閉じた・idle・切断）ときに呼ばれる。預かっている次の返信を回すのに使う（#305）。
   * 偽物は持たなくてよい（画面のポーリングのついでにも回すので、無くても止まりはしない）
   */
  onTurnEnd?(listener: (id: string) => void): void
}

interface ManagedTurn {
  entity: string
  threadId: string
  turnId?: string
  since: string
  text: string
}

interface Decision {
  id: string
  label: string
  behavior: 'allow' | 'deny'
  result: JsonObject
}

interface PendingApproval {
  approval: Approval
  requestId: RpcId
  requestKey: string
  threadId: string
  turnId: string
  method: string
  decisions: Decision[]
}

interface WaitingRpc {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

const REQUEST_TIMEOUT_MS = 30_000
const keyOf = (id: RpcId) => `${typeof id}:${String(id)}`
const object = (value: unknown): JsonObject | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : null

function errorText(error: unknown): string {
  const value = object(error)
  return typeof value?.message === 'string' ? value.message : JSON.stringify(error)
}

/** SAIサーバー配下に長寿命のstdio app-serverを1本だけ持つ。 */
export function realCodexConnector(env: NodeJS.ProcessEnv = process.env): CodexConnector {
  // 実行ファイルはサーバの PATH の `codex`（#288）
  const bin = 'codex'
  const extra = splitArgs(env.SAI_CODEX_APP_SERVER_ARGS)
  return async () => {
    // ここで回るターンも SAI が起動した子なので、サーバのペインを継がせない（#234）
    const child = spawn(bin, ['app-server', ...extra, '--stdio'], { env: childEnv(env), stdio: ['pipe', 'pipe', 'pipe'] })
    await new Promise<void>((resolve, reject) => {
      child.once('spawn', resolve)
      child.once('error', reject)
    })
    return new ProcessConnection(child)
  }
}

class ProcessConnection implements CodexConnection {
  private messages = new Set<(message: RpcMessage) => void>()
  private closes = new Set<(error?: Error) => void>()
  private ended = false
  private stderr = ''
  private readonly child: ChildProcessWithoutNullStreams

  constructor(child: ChildProcessWithoutNullStreams) {
    this.child = child
    const lines = createInterface({ input: child.stdout })
    lines.on('line', (line) => {
      let parsed: unknown
      try {
        parsed = JSON.parse(line)
      } catch {
        return
      }
      const message = object(parsed)
      if (message) for (const listener of this.messages) listener(message)
    })
    child.stderr.on('data', (chunk) => {
      this.stderr = (this.stderr + String(chunk)).slice(-2000)
    })
    child.once('error', (error) => this.finish(error))
    child.once('exit', (code, signal) => {
      const why = this.stderr.trim() || `Codex app-serverが終了しました（${signal ?? code ?? 'unknown'}）`
      this.finish(new Error(why))
    })
  }

  send(message: RpcMessage): void {
    if (this.ended || !this.child.stdin.writable) throw new Error('Codex app-serverは切断されています')
    this.child.stdin.write(`${JSON.stringify(message)}\n`)
  }

  onMessage(listener: (message: RpcMessage) => void): void {
    this.messages.add(listener)
  }

  onClose(listener: (error?: Error) => void): void {
    this.closes.add(listener)
  }

  close(): void {
    this.child.stdin.end()
  }

  private finish(error?: Error): void {
    if (this.ended) return
    this.ended = true
    for (const listener of this.closes) listener(error)
  }
}

/**
 * 1本のapp-server接続が、SAIから開始したthreadだけを所有する。
 * server requestは(threadId, turnId)が一致したものだけ画面へ出し、responseも同じ接続へ返す。
 */
export class CodexAppServer implements CodexApp {
  private connection: CodexConnection | null = null
  private connecting: Promise<CodexConnection> | null = null
  private nextId = 1
  private pending = new Map<string, WaitingRpc>()
  private turns = new Map<string, ManagedTurn>()
  private entityThreads = new Map<string, string>()
  private approvals = new Map<string, PendingApproval>()
  private items = new Map<string, JsonObject>()
  private turnEndListeners: ((id: string) => void)[] = []
  private readonly connect: CodexConnector
  private readonly now: () => number

  constructor(connect: CodexConnector = realCodexConnector(), now: () => number = Date.now) {
    this.connect = connect
    this.now = now
  }

  running(id: string): boolean {
    return this.entityThreads.has(id)
  }

  onTurnEnd(listener: (id: string) => void): void {
    this.turnEndListeners.push(listener)
  }

  /** ターンが終わったことを知らせる。知らせる側が投げても、ターンの片付けは止めない */
  private turnEnded(entity: string): void {
    for (const listener of this.turnEndListeners) {
      try {
        listener(entity)
      } catch {
        // 預かりを回す側の失敗で app-server の片付けを止めない
      }
    }
  }

  replying(): ReplyingMap {
    return Object.fromEntries([...this.turns.values()].map((turn) => [turn.entity, { since: turn.since, text: turn.text }]))
  }

  snapshot(): ApprovalMap {
    const out: ApprovalMap = {}
    for (const entry of this.approvals.values()) (out[entry.approval.id] ??= []).push(entry.approval)
    for (const list of Object.values(out)) list.sort((a, b) => a.since.localeCompare(b.since))
    return out
  }

  getApproval(approvalId: string): Approval | undefined {
    return this.approvals.get(approvalId)?.approval
  }

  async start(input: CodexTurnInput): Promise<void> {
    if (this.running(input.id)) throw new Error('このセッションはまだ前の返信を処理中です')
    const occupied = this.turns.get(input.threadId)
    if (occupied && occupied.entity !== input.id) throw new Error('このCodex threadは別のセッションとして処理中です')
    const turn: ManagedTurn = {
      entity: input.id,
      threadId: input.threadId,
      since: new Date(this.now()).toISOString(),
      text: input.text,
    }
    this.turns.set(input.threadId, turn)
    this.entityThreads.set(input.id, input.threadId)
    try {
      await this.request('thread/resume', {
        threadId: input.threadId,
        cwd: input.cwd,
        model: input.model ?? null,
        approvalsReviewer: 'user',
        excludeTurns: true,
      })
      const message: JsonObject = { type: 'text', text: input.text, text_elements: [] }
      const images = (input.attachments ?? []).map((path) => ({ type: 'localImage', path }))
      const response = object(await this.request('turn/start', {
        threadId: input.threadId,
        input: [message, ...images],
        cwd: input.cwd,
        model: input.model ?? null,
        approvalsReviewer: 'user',
      }))
      const started = object(response?.turn)
      if (typeof started?.id !== 'string' || !started.id) throw new Error('Codex app-serverのturn/start応答にturn idがありません')
      turn.turnId = started.id
    } catch (error) {
      this.clearThread(input.threadId)
      throw error
    }
  }

  answer(approvalId: string, answer: ApprovalAnswer): CodexAnswerResult {
    const entry = this.approvals.get(approvalId)
    if (!entry) return { ok: false, status: 404, error: 'approval not found' }
    const turn = this.turns.get(entry.threadId)
    if (!turn || (turn.turnId && turn.turnId !== entry.turnId)) {
      this.approvals.delete(approvalId)
      return { ok: false, status: 409, error: 'この質問は現在のCodex turnのものではありません' }
    }
    let result: JsonObject | null = null
    if (entry.method === 'item/tool/requestUserInput') {
      result = this.userInputResult(entry, answer)
      if (!result) return { ok: false, status: 400, error: '質問の回答が不足しているか、自由入力できない値です' }
    } else {
      const decision = entry.decisions.find((item) => item.id === answer.decision)
      if (!decision || decision.behavior !== answer.behavior) {
        return { ok: false, status: 400, error: '提示されていないdecisionです' }
      }
      result = decision.result
    }
    try {
      this.connection?.send({ id: entry.requestId, result })
    } catch (error) {
      return { ok: false, status: 409, error: error instanceof Error ? error.message : String(error) }
    }
    // responseは1回だけ。同じapproval idの二重回答は以後404になる
    this.approvals.delete(approvalId)
    return { ok: true }
  }

  private userInputResult(entry: PendingApproval, answer: ApprovalAnswer): JsonObject | null {
    if (answer.behavior === 'deny') return { answers: {} }
    const given = object(answer.updatedInput?.answers)
    const questions = Array.isArray(entry.approval.input.questions) ? entry.approval.input.questions : []
    if (!given || questions.length === 0) return null
    const answers: JsonObject = {}
    for (const raw of questions) {
      const question = object(raw)
      if (!question || typeof question.id !== 'string' || typeof question.question !== 'string') return null
      const value = given[question.id] ?? given[question.question]
      if (typeof value !== 'string' || !value.trim()) return null
      const options = Array.isArray(question.options) ? question.options.map(object).filter((v): v is JsonObject => !!v) : []
      const selected = options.some((option) => option.label === value) ? value : null
      if (!selected && question.isOther !== true) return null
      answers[question.id] = { answers: [selected ?? `user_note: ${value.trim()}`] }
    }
    return { answers }
  }

  private async ensureConnection(): Promise<CodexConnection> {
    if (this.connection) return this.connection
    if (this.connecting) return this.connecting
    this.connecting = (async () => {
      const connection = await this.connect()
      connection.onMessage((message) => this.onMessage(connection, message))
      connection.onClose((error) => this.onClose(connection, error))
      this.connection = connection
      try {
        await this.request('initialize', {
          clientInfo: { name: 'sai', title: 'SAI', version: '0.2.0' },
          capabilities: { experimentalApi: true, requestAttestation: false },
        })
        connection.send({ method: 'initialized' })
      } catch (error) {
        connection.close()
        throw error
      }
      return connection
    })()
    try {
      return await this.connecting
    } finally {
      this.connecting = null
    }
  }

  private async request(method: string, params: JsonObject): Promise<unknown> {
    const connection = method === 'initialize' && this.connection ? this.connection : await this.ensureConnection()
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      const key = keyOf(id)
      const timer = setTimeout(() => {
        this.pending.delete(key)
        reject(new Error(`Codex app-serverの${method}がタイムアウトしました`))
      }, REQUEST_TIMEOUT_MS)
      this.pending.set(key, { resolve, reject, timer })
      try {
        connection.send({ id, method, params })
      } catch (error) {
        clearTimeout(timer)
        this.pending.delete(key)
        reject(error)
      }
    })
  }

  private onMessage(connection: CodexConnection, message: RpcMessage): void {
    if (connection !== this.connection) return
    if (message.id !== undefined && !message.method) {
      const waiting = this.pending.get(keyOf(message.id))
      if (!waiting) return
      clearTimeout(waiting.timer)
      this.pending.delete(keyOf(message.id))
      if (message.error !== undefined) waiting.reject(new Error(errorText(message.error)))
      else waiting.resolve(message.result)
      return
    }
    if (message.id !== undefined && message.method) {
      this.onServerRequest(message.id, message.method, message.params)
      return
    }
    if (message.method) this.onNotification(message.method, message.params)
  }

  private onServerRequest(requestId: RpcId, method: string, rawParams: unknown): void {
    const params = object(rawParams)
    const threadId = typeof params?.threadId === 'string' ? params.threadId : ''
    const turnId = typeof params?.turnId === 'string' ? params.turnId : ''
    const itemId = typeof params?.itemId === 'string' ? params.itemId : ''
    const turn = this.turns.get(threadId)
    if (!params || !turn || !threadId || !turnId || !itemId || (turn.turnId && turn.turnId !== turnId)) {
      this.connection?.send({ id: requestId, error: { code: -32602, message: 'thread/turn is not managed by SAI' } })
      return
    }
    const built = this.buildApproval(turn, requestId, method, params, turnId, itemId)
    if (!built) {
      this.connection?.send({ id: requestId, error: { code: -32601, message: `unsupported server request: ${method}` } })
      return
    }
    this.approvals.set(built.approval.approval_id, built)
  }

  private buildApproval(turn: ManagedTurn, requestId: RpcId, method: string, params: JsonObject, turnId: string, itemId: string): PendingApproval | null {
    const approvalId = randomBytes(8).toString('hex')
    const since = typeof params.startedAtMs === 'number' ? new Date(params.startedAtMs).toISOString() : new Date(this.now()).toISOString()
    let toolName = ''
    let text = ''
    let input: JsonObject = {}
    let decisions: Decision[] = []

    if (method === 'item/tool/requestUserInput') {
      toolName = 'AskUserQuestion'
      const questions: JsonObject[] = Array.isArray(params.questions) ? params.questions.map((raw) => {
        const question = object(raw) ?? {}
        return { ...question, multiSelect: false }
      }) : []
      input = { questions, isBlocking: params.isBlocking === true }
      const summary = questions.map((q) => typeof q.question === 'string' ? q.question : '').filter(Boolean).join(' / ')
      text = summary ? `質問: ${summary}` : '質問に答えるのを待っている'
    } else if (method === 'item/commandExecution/requestApproval') {
      toolName = 'CodexCommand'
      input = pick(params, [
        'kind', 'approvalId', 'environmentId', 'command', 'cwd', 'reason', 'commandActions', 'additionalPermissions',
        'networkApprovalContext', 'proposedExecpolicyAmendment', 'proposedNetworkPolicyAmendments', 'availableDecisions',
      ])
      const summary = typeof params.command === 'string' ? params.command : typeof params.reason === 'string' ? params.reason : 'ネットワークアクセス'
      text = `許可待ち: コマンド: ${summary}`
      const available = Array.isArray(params.availableDecisions) && params.availableDecisions.length > 0
        ? params.availableDecisions
        : ['accept', 'decline']
      decisions = available.map((value, index) => decisionOf(index, value, { decision: value })).filter((v): v is Decision => !!v)
    } else if (method === 'item/fileChange/requestApproval') {
      toolName = 'CodexFileChange'
      const item = this.items.get(`${threadIdOf(params)}\n${itemId}`)
      const changes = item?.type === 'fileChange' && Array.isArray(item.changes) ? item.changes : []
      input = { ...pick(params, ['reason', 'grantRoot']), changes }
      const paths = changes.map(object).map((change) => change?.path).filter((path): path is string => typeof path === 'string')
      const target = paths.join(', ') || (typeof params.grantRoot === 'string' ? params.grantRoot : '') || (typeof params.reason === 'string' ? params.reason : 'ファイル変更')
      text = `許可待ち: ファイル変更: ${target}`
      decisions = ['accept', 'acceptForSession', 'decline', 'cancel'].map((value, index) => decisionOf(index, value, { decision: value }))
    } else if (method === 'item/permissions/requestApproval') {
      toolName = 'CodexPermissions'
      input = pick(params, ['cwd', 'reason', 'permissions', 'environmentId'])
      text = `追加権限の許可待ち: ${typeof params.reason === 'string' ? params.reason : permissionSummary(params.permissions)}`
      const requested = grantedPermissions(params.permissions)
      decisions = [
        { id: 'd0', label: '今回だけ許可', behavior: 'allow', result: { permissions: requested, scope: 'turn' } },
        { id: 'd1', label: 'セッション中許可', behavior: 'allow', result: { permissions: requested, scope: 'session' } },
        { id: 'd2', label: '拒否', behavior: 'deny', result: { permissions: {}, scope: 'turn' } },
      ]
    } else {
      return null
    }

    const approval: Approval = {
      approval_id: approvalId,
      id: turn.entity,
      since,
      tool_name: toolName,
      input,
      tool_use_id: itemId,
      text,
      agent: 'codex',
      answerable: true,
      ...(decisions.length ? { decisions: decisions.map(({ id, label, behavior }) => ({ id, label, behavior })) } : {}),
    }
    return { approval, requestId, requestKey: keyOf(requestId), threadId: turn.threadId, turnId, method, decisions }
  }

  private onNotification(method: string, rawParams: unknown): void {
    const params = object(rawParams)
    if (!params) return
    if (method === 'item/started') {
      const item = object(params.item)
      if (typeof params.threadId === 'string' && typeof item?.id === 'string') this.items.set(`${params.threadId}\n${item.id}`, item)
      return
    }
    if (method === 'serverRequest/resolved' && params.requestId !== undefined && (typeof params.requestId === 'string' || typeof params.requestId === 'number')) {
      const key = keyOf(params.requestId)
      for (const [approvalId, entry] of this.approvals) if (entry.requestKey === key) this.approvals.delete(approvalId)
      return
    }
    const threadId = typeof params.threadId === 'string' ? params.threadId : ''
    if (!threadId) return
    if (method === 'turn/started') {
      const turn = this.turns.get(threadId)
      const started = object(params.turn)
      if (turn && typeof started?.id === 'string') turn.turnId = started.id
      return
    }
    if (method === 'turn/completed' || method === 'thread/closed') {
      this.clearThread(threadId)
      return
    }
    if (method === 'thread/status/changed') {
      const status = object(params.status)
      const turn = this.turns.get(threadId)
      // thread/resume直後にもidleが届くことがある。turn/start前（turnIdなし）はまだ片付けない。
      if (turn?.turnId && (status?.type === 'idle' || status?.type === 'notLoaded' || status?.type === 'systemError')) this.clearThread(threadId)
    }
  }

  private onClose(connection: CodexConnection, error?: Error): void {
    if (connection !== this.connection) return
    this.connection = null
    const failure = error ?? new Error('Codex app-serverとの接続が切れました')
    for (const waiting of this.pending.values()) {
      clearTimeout(waiting.timer)
      waiting.reject(failure)
    }
    this.pending.clear()
    // 切断で終わったターンも「終わった」として知らせる（片付けてから。知らせた先が running() を見るので）
    const ended = [...this.turns.values()].map((turn) => turn.entity)
    this.turns.clear()
    this.entityThreads.clear()
    this.approvals.clear()
    this.items.clear()
    for (const entity of ended) this.turnEnded(entity)
  }

  private clearThread(threadId: string): void {
    const turn = this.turns.get(threadId)
    if (turn) this.entityThreads.delete(turn.entity)
    this.turns.delete(threadId)
    for (const [approvalId, entry] of this.approvals) if (entry.threadId === threadId) this.approvals.delete(approvalId)
    for (const key of this.items.keys()) if (key.startsWith(`${threadId}\n`)) this.items.delete(key)
    // 片付けてから知らせる（知らせた先が running() を見て次の返信を起動する）
    if (turn) this.turnEnded(turn.entity)
  }
}

function pick(source: JsonObject, keys: string[]): JsonObject {
  return Object.fromEntries(keys.filter((key) => source[key] !== undefined).map((key) => [key, source[key]]))
}

function threadIdOf(params: JsonObject): string {
  return typeof params.threadId === 'string' ? params.threadId : ''
}

function decisionOf(index: number, value: unknown, result: JsonObject): Decision {
  const name = typeof value === 'string' ? value : Object.keys(object(value) ?? {})[0] ?? 'decision'
  const labels: Record<string, string> = {
    accept: '許可',
    acceptForSession: 'セッション中許可',
    acceptWithExecpolicyAmendment: '同種のコマンドを許可',
    applyNetworkPolicyAmendment: 'ネットワーク規則を適用',
    decline: '拒否',
    cancel: 'ターンを中止',
  }
  return { id: `d${index}`, label: labels[name] ?? name, behavior: name === 'decline' || name === 'cancel' ? 'deny' : 'allow', result }
}

function grantedPermissions(raw: unknown): JsonObject {
  const requested = object(raw) ?? {}
  const result: JsonObject = {}
  if (requested.network) result.network = requested.network
  if (requested.fileSystem) result.fileSystem = requested.fileSystem
  return result
}

function permissionSummary(raw: unknown): string {
  const requested = object(raw)
  const fs = object(requested?.fileSystem)
  const paths = [...(Array.isArray(fs?.read) ? fs.read : []), ...(Array.isArray(fs?.write) ? fs.write : [])]
    .filter((path): path is string => typeof path === 'string')
  if (paths.length) return paths.join(', ')
  if (object(requested?.network)?.enabled === true) return 'ネットワークアクセス'
  return '追加権限'
}
