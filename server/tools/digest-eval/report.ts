// 一言（digest）の案を比べた結果の集計と、通す条件（#712）。**LLM は呼ばない純粋関数**。
//
// 出すのは件数と割合だけで、本文も一言も出さない（PR に貼れるのは数字だけ。実例は置き場の外の `outputs.jsonl` にだけ残る）。
// 比べるのは**両方の案で一言が取れた (事例, 回) の組だけ**（口が落ちた回を片方だけ数えると、落ちた側の件数が少なく見える）
import { DIGEST_MAX_CHARS } from '../../../shared/persona.ts'
import type { SummarizeStats } from '../../digest/digest.ts'
import { SCORE_LABELS, SCORE_ORDER } from './score.ts'
import type { ScoreCode } from './score.ts'

/** 1 回の出力（事例 × 案 × 回）。`error` があれば口が落ちた回で、採点はしていない */
export interface Sample {
  case: string
  /** 事例の形。記録から読んだ事例は `feed` */
  shape: string
  variant: string
  run: number
  summary: string
  /** 一言の長さ（文字） */
  chars: number
  codes: ScoreCode[]
  error?: string
  /** 口を呼んだ 1 回ごとの時間と数字（#740）。案が口を呼ばなければ空。**数字だけ**で本文は入らない */
  calls?: Call[]
}

/** 口の 1 回ぶん。`wall_ms` は道具が外から測った全体（プロセスの起動を含む）。`stats` は口が返した数字（`claude` だけ） */
export interface Call {
  wall_ms: number
  /** 口が落ちた回（時間切れなど） */
  failed?: boolean
  stats?: SummarizeStats
}

/**
 * 通す条件。**今のプロンプトより 1 件でも増えていたら通さない**項目の組（#712）。
 * `digestIssues()` の項目と、同じことを事例の側から見た項目をまとめて 1 つに数える（同じ出力を 2 回数えない）
 */
export const GATES: readonly { id: string; label: string; codes: readonly ScoreCode[] }[] = [
  { id: 'invented_number', label: '本文に無い番号', codes: ['invented_number', 'expect:number_extra'] },
  { id: 'dropped_request', label: '頼みが落ちた', codes: ['dropped_request', 'expect:request_dropped', 'expect:keep'] },
  { id: 'action_swap', label: '動作の取り違え', codes: ['action_swap', 'expect:action_wrong'] },
]

const GATE_CODES = new Set<ScoreCode>(GATES.flatMap((g) => g.codes))

export interface Lengths {
  min: number
  median: number
  p90: number
  max: number
  /** 目安（`DIGEST_MAX_CHARS`）を超えた数 */
  over: number
}

export interface VariantTotals {
  variant: string
  /** 一言が取れた数 */
  samples: number
  /** 口が落ちた数 */
  errors: number
  /** 何も引っかからなかった数 */
  clean: number
  /** 項目ごとの、引っかかった出力の数 */
  codes: Partial<Record<ScoreCode, number>>
  /** 通す条件の組ごとの、引っかかった出力の数 */
  gates: Record<string, number>
  lengths: Lengths
}

/** 小さい順に並べた列の p 分位（0〜1）。空なら 0 */
function quantile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return 0
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * p) - 1))]!
}

export function lengthsOf(chars: readonly number[]): Lengths {
  const sorted = [...chars].sort((a, b) => a - b)
  return { min: sorted[0] ?? 0, median: quantile(sorted, 0.5), p90: quantile(sorted, 0.9), max: sorted[sorted.length - 1] ?? 0, over: sorted.filter((n) => n > DIGEST_MAX_CHARS).length }
}

/** 案 1 つの集計 */
export function totalsOf(variant: string, samples: readonly Sample[]): VariantTotals {
  const own = samples.filter((s) => s.variant === variant)
  const ok = own.filter((s) => !s.error)
  const codes: Partial<Record<ScoreCode, number>> = {}
  for (const s of ok) for (const c of new Set(s.codes)) codes[c] = (codes[c] ?? 0) + 1
  const gates: Record<string, number> = {}
  for (const g of GATES) gates[g.id] = ok.filter((s) => s.codes.some((c) => g.codes.includes(c))).length
  return { variant, samples: ok.length, errors: own.length - ok.length, clean: ok.filter((s) => s.codes.length === 0).length, codes, gates, lengths: lengthsOf(ok.map((s) => s.chars)) }
}

const pairKey = (s: Sample) => `${s.case}\n${s.run}`

/** 両方の案で一言が取れた (事例, 回) の組だけを残す */
export function paired(samples: readonly Sample[], a: string, b: string): Sample[] {
  const okIn = (v: string) => new Set(samples.filter((s) => s.variant === v && !s.error).map(pairKey))
  const inA = okIn(a)
  const inB = okIn(b)
  return samples.filter((s) => (s.variant === a || s.variant === b) && !s.error && inA.has(pairKey(s)) && inB.has(pairKey(s)))
}

export interface CaseOutcome {
  case: string
  /** `base` = 今の案のほうが良い・`candidate` = 比べる案のほうが良い・`tie` */
  winner: 'base' | 'candidate' | 'tie'
}

export interface Comparison {
  base: VariantTotals
  candidate: VariantTotals
  /** 比べた (事例, 回) の組の数 */
  pairs: number
  /** 片方の口が落ちて比べられなかった組の数 */
  unpaired: number
  /** 項目ごとの差（比べる案 − 今の案）。0 のものは入れない */
  diffs: Partial<Record<ScoreCode, number>>
  /** 今の案より増えた項目 */
  worse: ScoreCode[]
  /** 通す条件の組ごとの件数。`failed` は今の案より増えたもの */
  gates: { id: string; label: string; base: number; candidate: number; failed: boolean }[]
  /** 通す条件を全部満たしたか。**比べた組が 1 つも無ければ満たさない**（比べる案の口が全部落ちたのを「増えていない」と読まない） */
  pass: boolean
  outcomes: CaseOutcome[]
}

/** 事例 1 つの重さ。通す条件の項目を先に比べ、同じなら全部の項目の数で比べる（小さいほど良い） */
function weight(samples: readonly Sample[]): [number, number] {
  let gate = 0
  let all = 0
  for (const s of samples) {
    all += s.codes.length
    gate += s.codes.filter((c) => GATE_CODES.has(c)).length
  }
  return [gate, all]
}

/** 今の案（base）と比べる案（candidate）を、同じ事例・同じ回で比べる */
export function compare(samples: readonly Sample[], base: string, candidate: string): Comparison {
  const both = paired(samples, base, candidate)
  const b = totalsOf(base, both)
  const c = totalsOf(candidate, both)
  const diffs: Partial<Record<ScoreCode, number>> = {}
  for (const code of SCORE_ORDER) {
    const d = (c.codes[code] ?? 0) - (b.codes[code] ?? 0)
    if (d !== 0) diffs[code] = d
  }
  const gates = GATES.map((g) => ({ id: g.id, label: g.label, base: b.gates[g.id] ?? 0, candidate: c.gates[g.id] ?? 0, failed: (c.gates[g.id] ?? 0) > (b.gates[g.id] ?? 0) }))
  const cases = [...new Set(both.map((s) => s.case))]
  const outcomes = cases.map((id): CaseOutcome => {
    const of = (v: string) => weight(both.filter((s) => s.case === id && s.variant === v))
    const [bg, ba] = of(base)
    const [cg, ca] = of(candidate)
    const winner = bg !== cg ? (bg < cg ? 'base' : 'candidate') : ba !== ca ? (ba < ca ? 'base' : 'candidate') : 'tie'
    return { case: id, winner }
  })
  const all = new Set(samples.filter((s) => s.variant === base || s.variant === candidate).map(pairKey)).size
  return { base: b, candidate: c, pairs: b.samples, unpaired: all - b.samples, diffs, worse: SCORE_ORDER.filter((code) => (diffs[code] ?? 0) > 0), gates, pass: b.samples > 0 && gates.every((g) => !g.failed), outcomes }
}

const rate = (n: number, of: number): string => (of > 0 ? `${n}（${Math.round((n / of) * 100)}%）` : String(n))
export interface Timing {
  variant: string
  /** 口を呼んだ回数（落ちた回を含む） */
  calls: number
  failed: number
  /** 外から測った全体（ミリ秒）。落ちた回を含む */
  wall: { mean: number; median: number; max: number }
  /** 口が数字を返した回だけの平均（無ければ null） */
  stats: null | {
    n: number
    /** CLI が測った全体 */
    cli_ms: number
    /** API を待っていた時間 */
    api_ms: number
    /** 外から測った全体 − CLI が測った全体 = プロセスの起動から CLI が測り始めるまで */
    startup_ms: number
    input: number
    cache_write: number
    cache_read: number
    output: number
    /** 回した分の合計（ドル） */
    cost_usd: number
  }
}

/** 案 1 つの、口の時間とトークンの集計（#740）。口を 1 回も呼んでいなければ null */
export function timingOf(variant: string, samples: readonly Sample[]): Timing | null {
  const calls = samples.filter((s) => s.variant === variant).flatMap((s) => s.calls ?? [])
  if (calls.length === 0) return null
  const walls = calls.map((c) => c.wall_ms).sort((a, b) => a - b)
  const mean = (xs: readonly number[]) => Math.round(xs.reduce((a, b) => a + b, 0) / xs.length)
  const withStats = calls.filter((c): c is Call & { stats: SummarizeStats } => c.stats !== undefined)
  const pick = (f: (s: SummarizeStats) => number) => mean(withStats.map((c) => f(c.stats)))
  return {
    variant,
    calls: calls.length,
    failed: calls.filter((c) => c.failed).length,
    wall: { mean: mean(walls), median: quantile(walls, 0.5), max: walls[walls.length - 1]! },
    stats:
      withStats.length === 0
        ? null
        : {
            n: withStats.length,
            cli_ms: pick((s) => s.duration_ms),
            api_ms: pick((s) => s.duration_api_ms),
            startup_ms: mean(withStats.map((c) => Math.max(0, c.wall_ms - c.stats.duration_ms))),
            input: pick((s) => s.input_tokens),
            cache_write: pick((s) => s.cache_write_tokens),
            cache_read: pick((s) => s.cache_read_tokens),
            output: pick((s) => s.output_tokens),
            cost_usd: withStats.reduce((a, c) => a + c.stats.cost_usd, 0),
          },
  }
}

const seconds = (ms: number): string => `${(ms / 1000).toFixed(1)} 秒`

/** 口の時間とトークンの表（#740）。どの案も口を呼んでいなければ空 */
export function timingTable(timings: readonly (Timing | null)[]): string[] {
  const shown = timings.filter((t): t is Timing => t !== null)
  if (shown.length === 0) return []
  const head = ['口の時間', ...shown.map((t) => t.variant)]
  const lines = [row(head), row(head.map(() => '---'))]
  lines.push(row(['口を呼んだ回数（うち落ちた）', ...shown.map((t) => `${t.calls}（${t.failed}）`)]))
  lines.push(row(['1 回の全体（平均 / 中央 / 最大）', ...shown.map((t) => `${seconds(t.wall.mean)} / ${seconds(t.wall.median)} / ${seconds(t.wall.max)}`)]))
  if (shown.some((t) => t.stats)) {
    const cell = (f: (s: NonNullable<Timing['stats']>) => string) => shown.map((t) => (t.stats ? f(t.stats) : '-'))
    // ここから下は、口が数字を返した回だけの平均（落ちた回は入らないので、上の全体とは足し合わない）
    lines.push(row(['数字を返した回の 起動まわり（全体 − CLI の中）', ...cell((s) => seconds(s.startup_ms))]))
    lines.push(row(['数字を返した回の CLI の中（うち API の中）', ...cell((s) => `${seconds(s.cli_ms)}（${seconds(s.api_ms)}）`)]))
    lines.push(row(['入力 / キャッシュの書き / 読み（平均トークン）', ...cell((s) => `${s.input} / ${s.cache_write} / ${s.cache_read}`)]))
    lines.push(row(['出力（平均トークン。思考を含む）', ...cell((s) => String(s.output))]))
    lines.push(row(['費用の合計（API 換算）', ...cell((s) => `$${s.cost_usd.toFixed(3)}（${s.n} 回）`)]))
  }
  return lines
}

const signed = (n: number): string => (n > 0 ? `+${n}` : String(n))
const row = (cells: readonly string[]): string => `| ${cells.join(' | ')} |`

/** 案ごとの件数の表（比べる前の全部。口が落ちた回は「口の失敗」に数える） */
export function totalsTable(totals: readonly VariantTotals[]): string[] {
  const head = ['項目', ...totals.map((t) => t.variant)]
  const lines = [row(head), row(head.map(() => '---'))]
  lines.push(row(['一言が取れた', ...totals.map((t) => String(t.samples))]))
  lines.push(row(['口の失敗', ...totals.map((t) => String(t.errors))]))
  lines.push(row(['何も引っかからない', ...totals.map((t) => rate(t.clean, t.samples))]))
  for (const g of GATES) lines.push(row([`**${g.label}**（通す条件）`, ...totals.map((t) => rate(t.gates[g.id] ?? 0, t.samples))]))
  for (const code of SCORE_ORDER) {
    if (totals.every((t) => !t.codes[code])) continue
    lines.push(row([`${SCORE_LABELS[code]} \`${code}\``, ...totals.map((t) => rate(t.codes[code] ?? 0, t.samples))]))
  }
  return lines
}

export function lengthsTable(totals: readonly VariantTotals[]): string[] {
  const head = ['長さ（文字）', ...totals.map((t) => t.variant)]
  const cell = (pick: (l: Lengths) => number) => totals.map((t) => String(pick(t.lengths)))
  return [
    row(head),
    row(head.map(() => '---')),
    row(['最小', ...cell((l) => l.min)]),
    row(['中央', ...cell((l) => l.median)]),
    row(['90%', ...cell((l) => l.p90)]),
    row(['最大', ...cell((l) => l.max)]),
    row([`${DIGEST_MAX_CHARS} 字超`, ...totals.map((t) => rate(t.lengths.over, t.samples))]),
  ]
}

/** 今の案と比べる案 1 つの差。**悪くなった項目は頭に ▲ を付けて先に並べる** */
export function comparisonLines(c: Comparison): string[] {
  const lines = [`### ${c.base.variant} → ${c.candidate.variant}`, '']
  lines.push(`比べた組（事例 × 回）: ${c.pairs}${c.unpaired > 0 ? `（片方の口が落ちて比べられなかった組: ${c.unpaired}）` : ''}`)
  lines.push('')
  const failed = c.gates.filter((g) => g.failed).map((g) => g.label).join('・')
  lines.push(c.pass ? '**通す条件: 満たした**' : `**通す条件: 満たしていない**（${c.pairs === 0 ? '比べられた組が 1 つも無い' : `${failed} が今より増えた`}）`)
  lines.push('')
  lines.push(row(['通す条件', c.base.variant, c.candidate.variant, '差']), row(['---', '---', '---', '---']))
  for (const g of c.gates) lines.push(row([`${g.failed ? '▲ ' : ''}${g.label}`, String(g.base), String(g.candidate), signed(g.candidate - g.base)]))
  const changed = SCORE_ORDER.filter((code) => c.diffs[code] !== undefined)
  if (changed.length > 0) {
    lines.push('', row(['変わった項目', c.base.variant, c.candidate.variant, '差']), row(['---', '---', '---', '---']))
    // 悪くなったものを先に
    for (const code of [...c.worse, ...changed.filter((x) => !c.worse.includes(x))]) {
      const worse = c.worse.includes(code)
      lines.push(row([`${worse ? '▲ ' : ''}${SCORE_LABELS[code]} \`${code}\``, String(c.base.codes[code] ?? 0), String(c.candidate.codes[code] ?? 0), signed(c.diffs[code] ?? 0)]))
    }
  } else {
    lines.push('', '項目ごとの件数に差は無い。')
  }
  const count = (w: CaseOutcome['winner']) => c.outcomes.filter((o) => o.winner === w)
  const ids = (w: CaseOutcome['winner']) => count(w).map((o) => o.case).join(', ') || '-'
  lines.push('', `事例ごと（${c.outcomes.length} 件）: ${c.candidate.variant} が良い ${count('candidate').length}・${c.base.variant} が良い ${count('base').length}・同じ ${count('tie').length}`)
  lines.push(`- ${c.candidate.variant} が良い: ${ids('candidate')}`, `- ${c.base.variant} が良い: ${ids('base')}`)
  return lines
}

export interface ReportInput {
  samples: readonly Sample[]
  /** 案の ID。**最初が今の案**（比べる相手） */
  variants: readonly string[]
  /** 何を回したか（事例の数・回数・口とモデル）。見出しの下にそのまま出す */
  notes?: readonly string[]
}

export interface Report {
  lines: string[]
  comparisons: Comparison[]
  /** 比べる案が全部、通す条件を満たしたか（案が 1 つだけなら true） */
  pass: boolean
}

/** 全体の結果（Markdown）。数字だけで、本文と一言は入らない */
export function report(input: ReportInput): Report {
  const [base, ...candidates] = input.variants
  if (!base) return { lines: [], comparisons: [], pass: true }
  const totals = input.variants.map((v) => totalsOf(v, input.samples))
  const comparisons = candidates.map((v) => compare(input.samples, base, v))
  const lines = ['## 一言の案の比べ', '', ...(input.notes ?? []).map((n) => `- ${n}`), '', ...totalsTable(totals), '', ...lengthsTable(totals)]
  const timing = timingTable(input.variants.map((v) => timingOf(v, input.samples)))
  if (timing.length > 0) lines.push('', ...timing)
  for (const c of comparisons) lines.push('', ...comparisonLines(c))
  return { lines, comparisons, pass: comparisons.every((c) => c.pass) }
}
