// SAI が起こした Claude のターンが、何トークン・いくら使ったか（#387）。
//
// `claude -p --output-format json`（と `stream-json`）が最後に返す `result` を読むだけ。
// **記録（~/.agent-feed/*.jsonl）には足さない**（フックが書くものだけ、を崩さない）。
// 読む元は reply.log のそのターンぶんなので、DOM にもファイルにも依存しない純粋関数にして turnUsage.test.ts で回す。

/** 1 ターン分。トークンは Claude の `usage`、費用は `total_cost_usd`（定額プランでは目安） */
export interface TurnUsage {
  /** 使ったモデル（`modelUsage` の最初の鍵）。分からなければ空 */
  model: string
  input_tokens: number
  output_tokens: number
  cache_read_input_tokens: number
  cache_creation_input_tokens: number
  /** CLI が出した費用（USD）。定額プランでは実際に請求されるものではない */
  cost_usd: number
  duration_ms: number
  /** CLI の中で回ったターン数（ツールの往復を含む） */
  num_turns: number
  /** 未許可で断られたツールの数。0 より大きければ、返信が空振りした理由になりうる */
  denials: number
  is_error: boolean
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
export function parseTurnUsage(text: string): TurnUsage | null {
  const lines = text.split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    const o = parseLine(lines[i] ?? '')
    if (!o) continue
    const usage = o.usage && typeof o.usage === 'object' && !Array.isArray(o.usage) ? (o.usage as Record<string, unknown>) : null
    if (!usage && typeof o.total_cost_usd !== 'number') continue
    const models = o.modelUsage && typeof o.modelUsage === 'object' && !Array.isArray(o.modelUsage) ? Object.keys(o.modelUsage as object) : []
    return {
      model: models[0] ?? '',
      input_tokens: num(usage?.input_tokens),
      output_tokens: num(usage?.output_tokens),
      cache_read_input_tokens: num(usage?.cache_read_input_tokens),
      cache_creation_input_tokens: num(usage?.cache_creation_input_tokens),
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
