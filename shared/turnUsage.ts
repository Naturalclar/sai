// SAI が起こした Claude のターンが、何トークン・いくら使ったか（#387）。
//
// `claude -p --output-format json`（と `stream-json`）が最後に返す `result` を読むだけ。
// **記録（~/.agent-feed/*.jsonl）には足さない**（フックが書くものだけ、を崩さない）。
// 読む元は reply.log のそのターンぶんなので、DOM にもファイルにも依存しない純粋関数にして turnUsage.test.ts で回す。

import { digestKey } from './digestFeedback.ts'
import { entityId } from './entity.ts'
import { eventKind } from './events.ts'
import type { FeedRow } from './types.ts'

/** 1 ターン分。トークンは Claude の `usage`、費用は `total_cost_usd`（定額プランでは目安） */
export interface TurnUsage {
  /** 使ったモデル（`modelUsage` の最初の鍵）。分からなければ空 */
  model: string
  input_tokens: number
  output_tokens: number
  cache_read_input_tokens: number
  cache_creation_input_tokens: number
  /**
   * CLI が出した費用（USD）。定額プランでは実際に請求されるものではない。
   * **turn-usage.jsonl の中ではそのセッションの積み上げ**（CLI の `total_cost_usd` のまま。`COST_CUMULATIVE_SINCE_MS` より前の行は 1 ターンぶん）で、行に載せるとき（`FeedRow.usage`）に
   * そのターンぶん（`turnCost()`。前の行との差）に直す（#602）
   */
  cost_usd: number
  duration_ms: number
  /** CLI の中で回ったターン数（ツールの往復を含む） */
  num_turns: number
  /** 未許可で断られたツールの数。0 より大きければ、返信が空振りした理由になりうる */
  denials: number
  is_error: boolean
  /**
   * 要約（`/compact`）だけのターン（#579）。記録に行を書かないので、**どのバブルにも付けない**（`usageByRow()` が飛ばす）。
   * 費用の集計には残す
   */
  compact?: true
}

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0)

/** `{...}` の 1 行だけを JSON として読む。読めなければ null */
function parseLine(line: string): Record<string, unknown> | null {
  const t = line.trim()
  if (!t.startsWith('{') || !t.endsWith('}')) return null
  try {
    const v: unknown = JSON.parse(t)
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null
  } catch {
    return null
  }
}

/**
 * reply.log のそのターンぶんから、CLI が最後に返した `result` を拾う。
 *
 * **末尾から探す**のは、前に別の出力が混ざるため: stdin を閉じていても CLI が警告を 1 行出すことがあり
 * （`Warning: no stdin data received in 3s …` を実測）、`--output-format stream-json` なら本文の行が先に並ぶ。
 * どちらの形でも「最後にある、`usage` か `total_cost_usd` を持つ JSON の行」が result なので、それだけを見る。
 * 見つからなければ null（`--output-format` を付けていない古い返信・素のテキスト・空）
 */
/** `modelUsage` の各モデルの量の合計（`usage` が 0 で返るときの補欠） */
function modelTotals(value: unknown): { input: number; output: number; cacheRead: number; cacheCreation: number } {
  const out = { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return out
  for (const m of Object.values(value as Record<string, unknown>)) {
    if (!m || typeof m !== 'object') continue
    const o = m as Record<string, unknown>
    out.input += num(o.inputTokens)
    out.output += num(o.outputTokens)
    out.cacheRead += num(o.cacheReadInputTokens)
    out.cacheCreation += num(o.cacheCreationInputTokens)
  }
  return out
}

export function parseTurnUsage(text: string): TurnUsage | null {
  const lines = text.split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    const o = parseLine(lines[i] ?? '')
    if (!o) continue
    const usage = o.usage && typeof o.usage === 'object' && !Array.isArray(o.usage) ? (o.usage as Record<string, unknown>) : null
    if (!usage && typeof o.total_cost_usd !== 'number') continue
    const models = o.modelUsage && typeof o.modelUsage === 'object' && !Array.isArray(o.modelUsage) ? Object.keys(o.modelUsage as object) : []
    // 要約だけのターン（#579）は `usage` が全部 0 で返り、実際の量は `modelUsage` にだけ載る（2.1.285 で実測）
    const byModel = modelTotals(o.modelUsage)
    const zero = !usage || (num(usage.input_tokens) + num(usage.output_tokens) + num(usage.cache_read_input_tokens) + num(usage.cache_creation_input_tokens) === 0)
    return {
      model: models[0] ?? '',
      input_tokens: zero ? byModel.input : num(usage?.input_tokens),
      output_tokens: zero ? byModel.output : num(usage?.output_tokens),
      cache_read_input_tokens: zero ? byModel.cacheRead : num(usage?.cache_read_input_tokens),
      cache_creation_input_tokens: zero ? byModel.cacheCreation : num(usage?.cache_creation_input_tokens),
      cost_usd: num(o.total_cost_usd),
      duration_ms: num(o.duration_ms),
      num_turns: num(o.num_turns),
      denials: Array.isArray(o.permission_denials) ? o.permission_denials.length : 0,
      is_error: o.is_error === true,
    }
  }
  return null
}

/** 読み書きした量の合計（キャッシュを含む）。画面に 1 つだけ出すならこれ */
export const totalTokens = (u: TurnUsage): number =>
  u.input_tokens + u.output_tokens + u.cache_read_input_tokens + u.cache_creation_input_tokens

const TAIL_CHARS = 300

/**
 * 失敗したときに画面へ出す 1 行（#172 の `ReplyFailure.tail`）。
 *
 * `--output-format json` を付けたので、**そのままだと JSON の切れ端が出る**（#387 の「気をつけること」）。
 * result が読めたときは CLI の本文（`result`）を出し、読めなければ今までどおり生の末尾を返す
 */
export function failureTail(raw: string): string {
  const lines = raw.split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    const o = parseLine(lines[i] ?? '')
    if (!o || (!o.usage && typeof o.total_cost_usd !== 'number')) continue
    const body = typeof o.result === 'string' ? o.result.trim() : ''
    const denials = Array.isArray(o.permission_denials) ? o.permission_denials.length : 0
    const note = denials > 0 ? `（未許可で断られたツール ${denials} 件）` : ''
    const text = `${body}${note}`.trim()
    if (text) return text.length <= TAIL_CHARS ? text : `${text.slice(0, TAIL_CHARS)}…`
  }
  return raw
}

/** turn-usage.jsonl の 1 行。`id` はエンティティ ID、`ts` は書いた時刻（= ターンが終わって CLI が終了した時刻） */
export interface TurnUsageEntry extends TurnUsage {
  ts: string
  id: string
}

/**
 * そのターンぶんの費用（#602）。**`cost_usd`（CLI の `total_cost_usd`）はそのセッションの積み上げ**で、1 ターンぶんではない
 * （実測で 822 行のうち 740 行が前の行以上）。同じセッションの前の行との差を返す。
 * 前の行より下がっていたら数え直しが入ったということなので、その行の値をそのまま返す。前の行が無ければ（最初のターン）その行の値
 */
export function turnCost(prev: number | undefined, cur: number): number {
  if (prev === undefined || cur < prev) return cur
  // 浮動小数の引き算の端数（0.30000000000000004 の類）を落とす。CLI の値は 6〜8 桁なので 1e-8 で足りる
  return Math.round((cur - prev) * 1e8) / 1e8
}

/**
 * `cost_usd` が積み上げになった時刻（#602 のレビュー）。**これより前の行はもともと 1 ターンぶん**なので、差にしない。
 *
 * 手元の記録の実測: 9/16〜9/18 は「前の行以上」が半分ほど（16/30・14/29・44/88）で、100 万トークンあたりの費用も行ごとに揃っている。
 * 9/19 の 03:38Z〜05:05Z の間から「前の行以上」がほぼ全部（37/41、以降 29/29・103/105…）になった。**なぜ変わったかは分かっていない**
 * （SAI のその日のコミットには無い。CLI の更新かもしれない）。行そのものからは区別が付かないので、時刻で切る。
 * 切り替わりはセッションごとにきれいには揃っていないので、境目の前後数時間の行は 1 ターンぶんずれうる
 */
export const COST_CUMULATIVE_SINCE_MS = Date.parse('2026-09-19T05:00:00Z')

/** その行の `cost_usd` が積み上げか。`ts` が無い・読めない行は積み上げとして扱う（いまの CLI の形） */
export function costIsCumulative(ts: string | undefined, since = COST_CUMULATIVE_SINCE_MS): boolean {
  const at = Date.parse(ts ?? '')
  return Number.isNaN(at) || at >= since
}

/** 費用が載っている行か（0 より大きい有限の数） */
export const hasCost = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v > 0

/**
 * 各行のそのターンぶんの費用（`entries` と同じ並び）。**渡す順 = 書いた順**（turn-usage.jsonl は追記だけなので、ファイルの順のまま）。
 * 前の行は同じ `id`（エンティティ）の中で辿る。要約だけのターン（`compact`）も同じ積み上げの中にあるので飛ばさない。
 * トークン（`*_tokens`）は 1 ターンぶんなので、差にしない
 */
export function turnCosts(entries: readonly (Pick<TurnUsageEntry, 'id' | 'cost_usd'> & { ts?: string })[], since = COST_CUMULATIVE_SINCE_MS): number[] {
  const last = new Map<string, number>()
  return entries.map((e) => {
    // 費用の無い行（0・数字でない。`num_turns` 0 の空振りやエラーの result）は 0 として、**前の行の値を忘れない**
    // （忘れると、次の行にそれまでの積み上げが丸ごと乗る。実測で 40.469 → 0 → 45.608）
    if (!hasCost(e.cost_usd)) return 0
    // 積み上げになる前の行は 1 ターンぶんのまま。積み上げの「前の行」にもしない
    if (!costIsCumulative(e.ts, since)) return e.cost_usd
    const cost = turnCost(last.get(e.id), e.cost_usd)
    last.set(e.id, e.cost_usd)
    return cost
  })
}

/**
 * 記録の行と、その使用量を結ぶときに許す差（#411）。
 *
 * 使用量の `ts` は **CLI が終了した時刻**、行の `ts` は **`Stop` フックが走った時刻**（record.py は秒に丸める）なので、
 * 使用量のほうが必ず後になる。実測（`claude -p --output-format json` を 3 ターン、手元で）で **0.6〜1.5 秒**だった。
 * 広くしすぎると、行を書かずに終わったターン（引数の誤りなどで `Stop` が走らないまま result だけ出た場合）の
 * ぶんが 1 つ前のバブルに付くので、実測の 80 倍だけ見て切る
 */
export const USAGE_MATCH_MS = 2 * 60_000

const ms = (ts: string): number => {
  const v = Date.parse(ts)
  return Number.isNaN(v) ? NaN : v
}

/**
 * どの行のぶんの使用量かを決める（#411）。**純粋関数**で、鍵は一言と同じ `<エンティティID>|<行の ts>`。
 *
 * 当てるのは「その使用量の `ts` 以前で一番新しい、**同じエンティティのターン完了の行**」で、差が `USAGE_MATCH_MS`
 * 以内のものだけ。**行より後にできる**という向きをそのまま規則にしてあるので、次のターンの使用量が前のバブルに
 * 付くことはない（前のバブルより後の行があれば、そちらに当たる）。
 * 1 つの行に 2 つ当たったら**先に来たほう**を採る（行を書かずに終わったターンのぶんに上書きさせない）。
 *
 * 行の `ts` はローカルのオフセット付き（`+09:00`）、使用量は UTC（`Z`）なので、**文字列ではなく時刻で比べる**
 */
export function usageByRow(rows: FeedRow[], entries: TurnUsageEntry[], windowMs = USAGE_MATCH_MS): Map<string, TurnUsageEntry> {
  const out = new Map<string, TurnUsageEntry>()
  if (entries.length === 0) return out
  // エンティティごとに、ターン完了の行だけを古い順に
  const byEntity = new Map<string, { at: number; row: FeedRow }[]>()
  for (const row of rows) {
    if (eventKind(row.event, row.text) !== 'turn') continue
    const at = ms(row.ts)
    if (Number.isNaN(at)) continue
    const id = entityId(row.session ?? '', row.repo ?? '', row.ts)
    const list = byEntity.get(id)
    if (list) list.push({ at, row })
    else byEntity.set(id, [{ at, row }])
  }
  for (const list of byEntity.values()) list.sort((a, b) => a.at - b.at)
  for (const e of [...entries].sort((a, b) => ms(a.ts) - ms(b.ts))) {
    // 要約だけのターン（#579）は行を書かないので、前のターンのバブルに付けない
    if (e.compact) continue
    const at = ms(e.ts)
    if (Number.isNaN(at)) continue
    const list = byEntity.get(e.id)
    if (!list) continue
    // その使用量より前の行だけを見て、一番新しいものを採る（**後の行は見ない**ので、向きはここで決まっている）
    let hit: FeedRow | null = null
    for (const item of list) {
      if (item.at > at) break
      hit = item.row
    }
    if (!hit || at - ms(hit.ts) > windowMs) continue
    const key = digestKey(hit)
    if (!out.has(key)) out.set(key, e)
  }
  return out
}
