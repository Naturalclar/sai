// 使用量の画面（#602）の集計。`turn-usage.jsonl`（SAI が起こした Claude のターン）を、期間で切ってセッション別・日別・モデル別に足す。
// DOM にもファイルにも触らない純粋関数（usageReport.test.ts）。**記録（JSONL）は触らない・API は叩かない**。
//
// 費用は渡す前に「そのターンぶん」に直しておく（`withTurnCosts()`。ファイルの `cost_usd` はセッションの積み上げ）。
// トークンは 1 ターンぶんなのでそのまま足す。
import { CONTEXT_WARN_TOKENS } from './contextSize.ts'
import { localDate } from './entity.ts'
import { COST_CUMULATIVE_SINCE_MS, turnCosts, type TurnUsageEntry } from './turnUsage.ts'
import type { UsageReportResponse, UsageReportRow, UsageSessionRow, UsageTotals } from './types.ts'

/** 画面で選べる期間（日）。先頭が既定 */
export const USAGE_REPORT_DAYS = [7, 1, 30] as const

/** 知らない値は既定（7 日）に落とす */
export function usageReportDays(raw: string | null | undefined): number {
  const n = Number(raw)
  return (USAGE_REPORT_DAYS as readonly number[]).includes(n) ? n : USAGE_REPORT_DAYS[0]
}

/** `cost_usd` をそのターンぶんに直した写し（積み上げになる前の行はそのまま。`since` はその境目）。**ファイルの順（書いた順）で、期間で切る前に**通す（切ってからだと、最初の行に積み上げが丸ごと乗る） */
export function withTurnCosts(entries: readonly TurnUsageEntry[], since = COST_CUMULATIVE_SINCE_MS): TurnUsageEntry[] {
  const costs = turnCosts(entries, since)
  return entries.map((e, i) => ({ ...e, cost_usd: costs[i] ?? 0 }))
}

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0)

const zero = (): UsageTotals => ({ turns: 0, input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, tokens: 0, cost_usd: 0, denials: 0, errors: 0 })

function add(t: UsageTotals, e: TurnUsageEntry): void {
  t.turns += 1
  t.input_tokens += num(e.input_tokens)
  t.output_tokens += num(e.output_tokens)
  t.cache_read_input_tokens += num(e.cache_read_input_tokens)
  t.cache_creation_input_tokens += num(e.cache_creation_input_tokens)
  t.tokens = t.input_tokens + t.output_tokens + t.cache_read_input_tokens + t.cache_creation_input_tokens
  t.cost_usd += num(e.cost_usd)
  t.denials += num(e.denials)
  if (e.is_error === true) t.errors += 1
}

/** 足し終わった費用の端数を落とす（0.1 + 0.2 の類を画面に出さない） */
const settle = (t: UsageTotals): UsageTotals => ({ ...t, cost_usd: Math.round(t.cost_usd * 1e6) / 1e6 })

const share = (part: number, whole: number): number => (whole > 0 ? part / whole : 0)

function rowsOf(groups: Map<string, UsageTotals>, total: UsageTotals): UsageReportRow[] {
  return [...groups].map(([key, t]) => ({ key, ...settle(t), token_share: share(t.tokens, total.tokens), cost_share: share(t.cost_usd, total.cost_usd) }))
}

/** トークンの多い順。同じなら鍵の順（並びを安定させる） */
const byTokens = (a: UsageReportRow, b: UsageReportRow): number => b.tokens - a.tokens || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0)

/**
 * 期間の中のターンを、セッション別・日別・モデル別に足す。
 *
 * - `entries` の `cost_usd` は**そのターンぶん**（`withTurnCosts()` を通したもの）
 * - 期間は `now` から `days` 日前まで（その時刻ちょうどを含む）。`ts` が読めない行は捨てる
 * - 日付は Asia/Tokyo（記録の日付の切り方と同じ）
 * - `names` はエンティティ ID → 呼び名。無いものは名前を付けない（画面が ID を出す）
 * - 読み直しが大きいかは「読み直し ÷ CLI の中で回ったターン数」で見る（1 回の返信の中でモデルを何度も呼ぶので、
 *   返信の数で割るといまのコンテキスト量より大きく出る）。区切りはコンテキストの注意（#441）と同じ
 */
export function usageReport(entries: readonly TurnUsageEntry[], opts: { now: number; days: number; names?: ReadonlyMap<string, string> }): UsageReportResponse {
  const since = opts.now - opts.days * 24 * 60 * 60_000
  const total = zero()
  const sessions = new Map<string, UsageTotals>()
  const calls = new Map<string, number>()
  const days = new Map<string, UsageTotals>()
  const models = new Map<string, UsageTotals>()
  const into = (m: Map<string, UsageTotals>, key: string, e: TurnUsageEntry): void => {
    let t = m.get(key)
    if (!t) m.set(key, (t = zero()))
    add(t, e)
  }
  for (const e of entries) {
    if (!e || typeof e.id !== 'string' || typeof e.ts !== 'string') continue
    const at = Date.parse(e.ts)
    if (Number.isNaN(at) || at < since || at > opts.now) continue
    add(total, e)
    into(sessions, e.id, e)
    calls.set(e.id, (calls.get(e.id) ?? 0) + Math.max(1, num(e.num_turns)))
    into(days, localDate(e.ts), e)
    into(models, typeof e.model === 'string' ? e.model : '', e)
  }
  const sessionRows = rowsOf(sessions, total)
    .sort(byTokens)
    .map((r): UsageSessionRow => {
      const perCall = Math.round(r.cache_read_input_tokens / (calls.get(r.key) ?? 1))
      const name = opts.names?.get(r.key)
      return { ...r, ...(name ? { name } : {}), read_per_call: perCall, heavy: perCall >= CONTEXT_WARN_TOKENS }
    })
  return {
    days: opts.days,
    since: new Date(since).toISOString(),
    total: settle(total),
    sessions: sessionRows,
    by_day: rowsOf(days, total).sort((a, b) => (a.key < b.key ? 1 : a.key > b.key ? -1 : 0)),
    by_model: rowsOf(models, total).sort(byTokens),
  }
}

