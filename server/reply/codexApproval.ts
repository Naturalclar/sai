// Codex の app-server が出してくる許可・質問の要求を、SAI の許可（`Approval`）と押せる候補に組む。
// SAI 自身の stdio の app-server（`codexAppServer.ts`）と、共有の app-server（daemon。`codexDaemon.ts`。#848 の 3）の 2 つが同じものを使う
import { randomBytes } from 'node:crypto'
import type { Approval, ApprovalAnswer, CodexKept } from '../../shared/types.ts'
import { amendmentLabel } from './codexAmendment.ts'

type JsonObject = Record<string, unknown>

export interface CodexDecision {
  id: string
  label: string
  behavior: 'allow' | 'deny'
  result: JsonObject
  /** 押すとこの 1 回を越えて残る（規則の追加） */
  persists?: true
  /** 規則の追加のとき、ボタンに書いた範囲（#772。答えの結果に載せて記録に残す。画面には渡さない） */
  kept?: CodexKept
}

export interface CodexApprovalInput {
  /** 画面のエンティティ ID */
  entity: string
  method: string
  params: JsonObject
  itemId: string
  /** `startedAtMs` が無いときの時刻（ミリ秒） */
  now: number
  /** ファイル変更の許可のとき、同じ id の `item/started` の item（要求の `params` に差分は無い） */
  item?: JsonObject
}

const object = (value: unknown): JsonObject | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : null

/** 知らない形の要求は null（呼ぶ側が答えない・出さない） */
export function buildCodexApproval(input: CodexApprovalInput): { approval: Approval; decisions: CodexDecision[] } | null {
  const { entity, method, params, itemId } = input
  const approvalId = randomBytes(8).toString('hex')
  const since = typeof params.startedAtMs === 'number' ? new Date(params.startedAtMs).toISOString() : new Date(input.now).toISOString()
  let toolName = ''
  let text = ''
  let fields: JsonObject = {}
  let decisions: CodexDecision[] = []
  let unanswerable = false

  if (method === 'item/tool/requestUserInput') {
    toolName = 'AskUserQuestion'
    const questions: JsonObject[] = Array.isArray(params.questions) ? params.questions.map((raw) => {
      const question = object(raw) ?? {}
      return { ...question, multiSelect: false }
    }) : []
    fields = { questions, isBlocking: params.isBlocking === true }
    const summary = questions.map((q) => typeof q.question === 'string' ? q.question : '').filter(Boolean).join(' / ')
    text = summary ? `質問: ${summary}` : '質問に答えるのを待っている'
  } else if (method === 'item/commandExecution/requestApproval') {
    toolName = 'CodexCommand'
    fields = pick(params, [
      'kind', 'approvalId', 'environmentId', 'command', 'cwd', 'reason', 'commandActions', 'additionalPermissions',
      'networkApprovalContext', 'proposedExecpolicyAmendment', 'proposedNetworkPolicyAmendments', 'availableDecisions',
    ])
    const summary = typeof params.command === 'string' ? params.command : typeof params.reason === 'string' ? params.reason : 'ネットワークアクセス'
    text = `許可待ち: コマンド: ${summary}`
    const available = Array.isArray(params.availableDecisions) && params.availableDecisions.length > 0
      ? params.availableDecisions
      : ['accept', 'decline']
    decisions = available.map((value, index) => decisionOf(index, value, { decision: value })).filter((v): v is CodexDecision => !!v)
    // 出せる候補が 1 つも残らなかった（来たのが、範囲を書けない規則の追加・知らない形だけ）。来ていない候補は足さないので、
    // 画面からは答えられない。そう出して、止めるのは「止める」に任せる（黙って押せないボタンを並べない。#742 のレビュー）
    unanswerable = decisions.length === 0
  } else if (method === 'item/fileChange/requestApproval') {
    toolName = 'CodexFileChange'
    const item = input.item
    const changes = item?.type === 'fileChange' && Array.isArray(item.changes) ? item.changes : []
    fields = { ...pick(params, ['reason', 'grantRoot']), changes }
    const paths = changes.map(object).map((change) => change?.path).filter((path): path is string => typeof path === 'string')
    const target = paths.join(', ') || (typeof params.grantRoot === 'string' ? params.grantRoot : '') || (typeof params.reason === 'string' ? params.reason : 'ファイル変更')
    text = `許可待ち: ファイル変更: ${target}`
    decisions = ['accept', 'acceptForSession', 'decline', 'cancel'].map((value, index) => plainDecision(index, value))
  } else if (method === 'item/permissions/requestApproval') {
    toolName = 'CodexPermissions'
    fields = pick(params, ['cwd', 'reason', 'permissions', 'environmentId'])
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
    id: entity,
    since,
    tool_name: toolName,
    input: fields,
    tool_use_id: itemId,
    text,
    agent: 'codex',
    answerable: !unanswerable,
    ...(decisions.length ? { decisions: decisions.map(({ id, label, behavior, persists }) => ({ id, label, behavior, ...(persists ? { persists } : {}) })) } : {}),
  }
  return { approval, decisions }
}

/**
 * 画面の答えを、要求に返す `result` にする。**出した候補・出した質問の答えだけ**を通し、それ以外は null（呼ぶ側が 400 で断る）。
 * `decision` は押した候補（質問のときは無い）
 */
export function codexAnswerResult(approval: Approval, method: string, decisions: readonly CodexDecision[], answer: ApprovalAnswer): { result: JsonObject; decision?: CodexDecision } | null {
  if (method === 'item/tool/requestUserInput') {
    const result = userInputResult(approval, answer)
    return result ? { result } : null
  }
  const decision = decisions.find((item) => item.id === answer.decision)
  if (!decision || decision.behavior !== answer.behavior) return null
  return { result: decision.result, decision }
}

function userInputResult(approval: Approval, answer: ApprovalAnswer): JsonObject | null {
  if (answer.behavior === 'deny') return { answers: {} }
  const given = object(answer.updatedInput?.answers)
  const questions = Array.isArray(approval.input.questions) ? approval.input.questions : []
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

function pick(source: JsonObject, keys: string[]): JsonObject {
  return Object.fromEntries(keys.filter((key) => source[key] !== undefined).map((key) => [key, source[key]]))
}

/** 今回かぎりの候補（規則を足さないもの）の文言と向き。**ここに無い名前の候補は出さない** */
const PLAIN_DECISIONS: Record<string, { label: string; behavior: 'allow' | 'deny' }> = {
  accept: { label: '許可', behavior: 'allow' },
  acceptForSession: { label: 'セッション中許可', behavior: 'allow' },
  decline: { label: '拒否', behavior: 'deny' },
  cancel: { label: 'ターンを中止', behavior: 'deny' },
}

/** SAI が自分で並べる候補（ファイル変更）。名前は `PLAIN_DECISIONS` にあるものだけ */
function plainDecision(index: number, name: keyof typeof PLAIN_DECISIONS & string): CodexDecision {
  return { id: `d${index}`, ...PLAIN_DECISIONS[name]!, result: { decision: name } }
}

/**
 * Codex が出してきた候補 1 つをボタンにする。出すのは**知っている形だけ**（#741）:
 * - 今回かぎりの候補（`PLAIN_DECISIONS`）
 * - 規則の追加（今後も聞かない）で、範囲をボタンに書けるもの（`amendmentLabel()`）
 *
 * それ以外（範囲を書けない規則の追加・知らない名前の候補）は null で、呼ぶ側が落とす。知らない名前を英語のまま「許可」の色で出すと、
 * 何が起きるか分からないボタンになる（新しい版の Codex が別の「今後も…」を足してきたとき。#742 のレビュー）。
 * id は元の並びの番号のまま（落とした候補の id は誰にも渡らないので、答えにも使えない）
 */
function decisionOf(index: number, value: unknown, result: JsonObject): CodexDecision | null {
  const amendment = amendmentLabel(value)
  if (amendment === null) return null
  if (amendment) return { id: `d${index}`, ...amendment, result, persists: true }
  const plain = typeof value === 'string' && Object.hasOwn(PLAIN_DECISIONS, value) ? PLAIN_DECISIONS[value] : undefined
  return plain ? { id: `d${index}`, ...plain, result } : null
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
