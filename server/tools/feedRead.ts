// `~/.agent-feed` を読む調査の「読み方」を 1 か所にまとめたもの（#703）。**読むだけ**で、置き場には何も書かない。
//
// 調査のたびに使い捨てのスクリプトで読み方を書き直していて、実際に 2 つ数え間違えた
// （`turn-usage.jsonl` の `cost_usd` を積み上げのまま足した・要約の文を人の入力として数えた）。
// ここは読み方を新しく決めず、サーバと画面が使っている `shared/` の判定をそのまま呼ぶ
// （エンティティの ID = `entityId()`、ターン完了 = `eventKind() === 'turn'`、日付 = `Asia/Tokyo`、費用 = `turnCosts()`）。
// コマンドは `server/tools/feed.ts`（`pnpm feed`）。その場かぎりの問いは、ここの関数を import して書く。
import { readdir, readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { AGENT_HEADER_MARK, agentReplyRows, resolveTarget, splitHandedReplies } from '../../shared/agentMessages.ts'
import type { ResolvedTarget } from '../../shared/agentMessages.ts'
import { isCompactSummaryText } from '../../shared/compactSummary.ts'
import { entityId, localDate } from '../../shared/entity.ts'
import { eventKind } from '../../shared/events.ts'
import { turnCosts } from '../../shared/turnUsage.ts'
import type { TurnUsageEntry } from '../../shared/turnUsage.ts'
import type { FeedRow, SessionMeta, SessionSummary } from '../../shared/types.ts'
import { AGENT_MESSAGES_FILE } from '../reply/agentMessages.ts'
import type { AgentMessage } from '../reply/agentMessages.ts'
import { TURN_USAGE_FILE } from '../reply/turnUsage.ts'
import { aggregate } from '../rows/aggregate.ts'
import { feedFiles, parseRows } from '../rows/store.ts'
import { META_FILE } from '../meta/meta.ts'

/** 置き場。記録側・サーバと同じ `AGENT_FEED_DIR`（無ければ `~/.agent-feed`） */
export function feedDir(env: NodeJS.ProcessEnv = process.env): string {
  const raw = env.AGENT_FEED_DIR || join(homedir(), '.agent-feed')
  return resolve(raw === '~' || raw.startsWith('~/') ? join(homedir(), raw.slice(1)) : raw)
}

const DAY_MS = 86_400_000
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

/** 日付（`YYYY-MM-DD`）か。範囲の指定に使う */
export const isDate = (v: string): boolean => DATE_RE.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`))

/** `from` 〜 `to`（両端を含む）の日付を古い順に。読めない・逆さまなら空 */
export function datesBetween(from: string, to: string): string[] {
  if (!isDate(from) || !isDate(to)) return []
  const out: string[] = []
  const end = Date.parse(`${to}T00:00:00Z`)
  for (let d = Date.parse(`${from}T00:00:00Z`); d <= end; d += DAY_MS) out.push(new Date(d).toISOString().slice(0, 10))
  return out
}

export interface DateRange {
  from: string
  to: string
}

/**
 * 読む日付の範囲。日付は記録と同じ `Asia/Tokyo` で切る。`to` の既定は今日、`from` の既定は `to` から `days` 日ぶん
 * （`days` 1 = `to` の 1 日だけ）
 */
export function dateRange(opts: { from?: string; to?: string; days?: number }, now: Date = new Date()): DateRange {
  const to = opts.to || localDate(now.toISOString())
  if (opts.from) return { from: opts.from, to }
  const days = Math.max(1, Math.floor(opts.days ?? 1))
  return { from: new Date(Date.parse(`${to}T00:00:00Z`) - (days - 1) * DAY_MS).toISOString().slice(0, 10), to }
}

/** その時刻が範囲の中か（`Asia/Tokyo` の日付で見る） */
export function inRange(ts: string, range: DateRange): boolean {
  const d = localDate(ts)
  return d >= range.from && d <= range.to
}

/**
 * 範囲の行を古い順に読む。ファイルは日付から組み立てず `readdir` で拾う（`YYYY-MM-DD.<host>.jsonl` も読む。#113）。
 * サーバ（`FeedStore.rows()`）と同じく、置き場を cwd にした行（一言を作る子のターン）は SAI 自身の雑音として落とす
 */
export async function readRows(dir: string, range: DateRange): Promise<FeedRow[]> {
  let names: string[]
  try {
    names = await readdir(dir)
  } catch {
    return [] // 置き場がまだ無い
  }
  const rows: FeedRow[] = []
  for (const name of feedFiles(names, datesBetween(range.from, range.to))) {
    let text: string
    try {
      text = await readFile(join(dir, name), 'utf-8')
    } catch {
      continue // 読む直前に消えたぶんは飛ばす
    }
    for (const r of parseRows(text)) {
      const cwd = r.cwd ?? ''
      if (cwd !== dir && !cwd.startsWith(dir + sep)) rows.push(r)
    }
  }
  // 別マシンのファイルは日付ごとに後ろに付くので ts に並べ直す（sort は安定なので同じ ts は読んだ順）
  rows.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0))
  return rows
}

/** 行が属するエンティティの ID（`<セッション>@<リポジトリ>`）。自分で組み立てず必ずここを通す */
export function rowEntity(row: FeedRow): string {
  return entityId(row.session ?? '', row.repo ?? '', String(row.ts ?? ''))
}

/** ターン完了の行か。`turns` と「返信が終わった」はこの行だけで数える */
export function isTurn(row: FeedRow): boolean {
  return eventKind(row.event, row.text) === 'turn'
}

/**
 * `user_text` が何か。人の入力を数えるときは `human` だけを数える。
 * - `compact`: 自動の要約の文（人は打っていない。#626）
 * - `message`: 別のセッションから SAI が届けたメッセージ（`【SAI】…`）
 * - `empty`: 入力が無い（バックグラウンドの通知で回ったターン・頭に足した返答の塊だけ、など）
 *
 * スキルの本文が入力として載った行はまだ見分けていない（`human` に入る）
 */
export type PromptKind = 'human' | 'compact' | 'message' | 'empty'

export function promptKind(userText: string | undefined): PromptKind {
  if (isCompactSummaryText(userText)) return 'compact'
  const text = splitHandedReplies(userText ?? '').text.trim()
  if (!text) return 'empty'
  return text.startsWith(AGENT_HEADER_MARK) ? 'message' : 'human'
}

/** 人が打った文（頭に足した返答の塊は外す）。要約・メッセージ・空なら空 */
export function humanPrompt(userText: string | undefined): string {
  return promptKind(userText) === 'human' ? splitHandedReplies(userText ?? '').text.trim() : ''
}

/**
 * 入力の行と完了の行の 1 組。
 * - `done`: 完了の行があり、本文もある
 * - `empty`: 完了の行はあるが本文が空
 * - `missing`: 入力の行のあと、完了の行が来ないまま次の入力・`入力待ち`・セッションの終了が来た
 *   （完了の行が落ちた。**走っているターンに足した入力もこう見える**ので、数えるときは前後を読む）
 * - `open`: 入力の行が最後で、まだ何も来ていない（回っている最中か、落ちたか）
 */
export type TurnState = 'done' | 'empty' | 'missing' | 'open'

export interface TurnPair {
  entity: string
  /** 入力した瞬間の行（`UserPromptSubmit`）。入力の行を書かない経路・古い行では無い */
  prompt?: FeedRow
  /** ターン完了の行 */
  stop?: FeedRow
  /** そのターンの入力。完了の行の `user_text` が要約の文に置き換わっていたら、入力の行のほうを採る */
  user_text: string
  kind: PromptKind
  state: TurnState
}

/** 入力の行と完了の行を対応付ける。`rows` は古い順（別のエンティティが混ざっていてよい）。返すのは始まりの古い順 */
export function pairTurns(rows: readonly FeedRow[]): TurnPair[] {
  const pending = new Map<string, FeedRow>()
  const out: TurnPair[] = []
  const lost = (entity: string, state: 'missing' | 'open') => {
    const prompt = pending.get(entity)
    if (!prompt) return
    pending.delete(entity)
    out.push({ entity, prompt, user_text: prompt.user_text ?? '', kind: promptKind(prompt.user_text), state })
  }
  for (const row of rows) {
    const kind = eventKind(row.event, row.text)
    if (kind === 'waiting' || kind === 'other') continue
    const entity = rowEntity(row)
    if (kind === 'idle' || kind === 'end') {
      lost(entity, 'missing')
      continue
    }
    if (kind === 'resume') {
      // 本文の無い合図だけの行（待ちのあとの再開）は入力の行ではない
      if (!row.user_text?.trim()) continue
      lost(entity, 'missing')
      pending.set(entity, row)
      continue
    }
    const prompt = pending.get(entity)
    pending.delete(entity)
    const userText = isCompactSummaryText(row.user_text) ? (prompt?.user_text ?? row.user_text ?? '') : (row.user_text ?? prompt?.user_text ?? '')
    out.push({ entity, ...(prompt ? { prompt } : {}), stop: row, user_text: userText, kind: promptKind(userText), state: row.text?.trim() ? 'done' : 'empty' })
  }
  for (const entity of [...pending.keys()]) lost(entity, 'open')
  const at = (p: TurnPair) => (p.prompt ?? p.stop)!.ts
  return out.sort((a, b) => (at(a) < at(b) ? -1 : at(a) > at(b) ? 1 : 0))
}

async function readJson(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, 'utf-8'))
  } catch {
    return null // 無い・壊れている
  }
}

/** `session-meta.json`（表示名・アーカイブ）。無ければ空 */
export async function readMeta(dir: string): Promise<Record<string, SessionMeta>> {
  const raw = await readJson(join(dir, META_FILE))
  return raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, SessionMeta>) : {}
}

/**
 * 行をセッションにまとめ、表示名とアーカイブを載せる（新しい順）。アーカイブ済みかはサーバと同じく
 * `archived_at >= 最後の行の ts` で決める
 */
export function sessionsOf(rows: FeedRow[], meta: Record<string, SessionMeta> = {}): SessionSummary[] {
  return aggregate(rows).map((s) => {
    const m = meta[s.id]
    if (!m || typeof m !== 'object') return s
    const archived = !!m.archived_at && Date.parse(m.archived_at) >= Date.parse(s.end)
    return { ...s, meta: m, ...(archived ? { archived: true } : {}) }
  })
}

/** ID の頭で引くときの最短の長さ（短すぎる頭で当てない） */
export const ID_PREFIX_MIN = 4

/**
 * セッションの指定を引く。`sai_send` の宛先（#625）と同じ `resolveTarget()`: ID がそのまま当たればそれ、当たらなければ
 * 名前（ID・表示名・worktree 名・呼び名。前後の空白と大文字小文字だけ無視）の完全一致で、**ちょうど 1 つのときだけ**返す。
 * 決まらなければ候補を返す（当てずっぽうで別のセッションを読まない）。
 *
 * 調べものの道具なので 2 つだけ足してある: アーカイブしていない中で決まればそれを採る（同じ worktree の古いセッションで
 * あいまいにならないように）。名前で 1 つも当たらなければ ID の頭（`ID_PREFIX_MIN` 字以上）で引く
 */
export function resolveSession(sessions: readonly SessionSummary[], query: string): ResolvedTarget {
  const live = sessions.filter((s) => !s.archived)
  for (const pool of [live, sessions]) {
    const r = resolveTarget(pool, query)
    if (r.target || r.ambiguous) return r
  }
  const key = query.trim().toLowerCase()
  const hits = key.length >= ID_PREFIX_MIN ? sessions.filter((s) => s.id.toLowerCase().startsWith(key)) : []
  if (hits.length === 1) return { target: hits[0]! }
  return { target: null, ambiguous: hits.length > 1, candidates: hits.length > 0 ? hits : live }
}

/** `turn-usage.jsonl` を書いた順（= ファイルの順）に読む。壊れた行は落とす */
export async function readTurnUsage(dir: string): Promise<TurnUsageEntry[]> {
  let text: string
  try {
    text = await readFile(join(dir, TURN_USAGE_FILE), 'utf-8')
  } catch {
    return []
  }
  const out: TurnUsageEntry[] = []
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    try {
      const e = JSON.parse(line) as TurnUsageEntry
      if (e && typeof e.ts === 'string' && typeof e.id === 'string') out.push(e)
    } catch {
      // 壊れた行は落とす
    }
  }
  return out
}

/** 使用量の 1 行に、そのターンぶんの費用を足したもの */
export interface UsageRow extends TurnUsageEntry {
  /** そのターンぶんの費用。**ファイルの `cost_usd` はセッションの積み上げ**なので、足すのは必ずこちら */
  turn_cost_usd: number
}

/**
 * 各行にそのターンぶんの費用（同じセッションの前の行との差。`turnCosts()`）を付ける。
 * **範囲で絞る前の、ファイルの全部を渡す**（絞ってから渡すと、範囲の最初の行にそれまでの積み上げが丸ごと乗る）
 */
export function usageRows(entries: readonly TurnUsageEntry[]): UsageRow[] {
  const costs = turnCosts(entries)
  return entries.map((e, i) => ({ ...e, turn_cost_usd: costs[i]! }))
}

export interface UsageTotal {
  /** エンティティの ID か、日付（`Asia/Tokyo`） */
  key: string
  /** 行の数（SAI から回したターンの数。要約だけのターンも含む） */
  turns: number
  input_tokens: number
  output_tokens: number
  cache_read_input_tokens: number
  cache_creation_input_tokens: number
  /** そのターンぶんの費用の合計 */
  cost_usd: number
}

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0)

/** セッション別・日別に足す。セッション別は費用の多い順、日別は古い順 */
export function usageTotals(rows: readonly UsageRow[], by: 'session' | 'day'): UsageTotal[] {
  const totals = new Map<string, UsageTotal>()
  for (const r of rows) {
    const key = by === 'day' ? localDate(r.ts) : r.id
    const t = totals.get(key) ?? { key, turns: 0, input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, cost_usd: 0 }
    t.turns += 1
    t.input_tokens += num(r.input_tokens)
    t.output_tokens += num(r.output_tokens)
    t.cache_read_input_tokens += num(r.cache_read_input_tokens)
    t.cache_creation_input_tokens += num(r.cache_creation_input_tokens)
    t.cost_usd = Math.round((t.cost_usd + r.turn_cost_usd) * 1e8) / 1e8
    totals.set(key, t)
  }
  const out = [...totals.values()]
  return by === 'day' ? out.sort((a, b) => (a.key < b.key ? -1 : 1)) : out.sort((a, b) => b.cost_usd - a.cost_usd)
}

/** `agent-messages.json` の送った記録を古い順に。無ければ空 */
export async function readAgentMessages(dir: string): Promise<AgentMessage[]> {
  const raw = (await readJson(join(dir, AGENT_MESSAGES_FILE))) as { messages?: unknown } | null
  if (!raw || !Array.isArray(raw.messages)) return []
  return (raw.messages as AgentMessage[]).filter((m) => m && typeof m.message_id === 'string' && typeof m.to === 'string' && typeof m.since === 'string')
}

export interface MessageReply {
  message: AgentMessage
  /** 相手の返答になった行（そのメッセージで回った、相手のターン完了の行）。まだ無い・読んだ範囲に無ければ null */
  reply: FeedRow | null
}

/**
 * 送ったメッセージと返答を引き当てる。画面と同じ `agentReplyRows()`（見出しの id で見る。要約で入力が置き換わった行は
 * 直前の入力の行で当てる）。`rows` は古い順で、**メッセージを送った日から後ろを全部**渡す
 */
export function messageReplies(messages: readonly AgentMessage[], rows: readonly FeedRow[]): MessageReply[] {
  const replies = new Map<string, FeedRow>()
  for (const r of agentReplyRows(messages, rows, () => '')) if (r.agent_reply) replies.set(r.agent_reply.message_id, r)
  return messages.map((message) => ({ message, reply: replies.get(message.message_id) ?? null }))
}
