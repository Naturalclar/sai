// 使用量（usage limit）の読み方と言い換え。ファイルを触らない純粋関数だけを置き、
// サーバ（server/local/usage.ts が JSONL の行を渡す）と画面（web/src/UsageChip.tsx が言い換えを使う）が同じものを見る。
//
// **エージェントで取れるものが違う**（#216 / #250 で手元のファイルを見て確かめた）:
//   Codex  … rollout の token_count の行に rate_limits が毎ターン載る。5 時間と週の割合が分かる
//   Claude … 割合は**ステータスライン**（feed/statusline.py が書く usage-claude.json）から。
//            transcript の quotaLimits は**弾かれたときだけ**載るので「上限中」の合図にしかならない
// どちらも手元のファイルを読むだけで、API は叩かない。
import type { ClaudeUsage, CodexUsage, UsageWindow } from './types.ts'

/** primary の枠の長さ（分）。Codex の 5 時間 */
export const FIVE_HOURS_MINUTES = 300
/** secondary の枠の長さ（分）。Codex の 1 週間 */
export const WEEK_MINUTES = 10080

/** これを超えたら見た目を変える（返信を投げる前に気づけるように） */
export const USAGE_WARN = 80
/** これを超えたらさらに強く */
export const USAGE_HIGH = 95

export type UsageLevel = 'ok' | 'warn' | 'high'

export function usageLevel(percent: number): UsageLevel {
  if (percent >= USAGE_HIGH) return 'high'
  if (percent >= USAGE_WARN) return 'warn'
  return 'ok'
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)

/** rate_limits の primary / secondary 1 つ分。used_percent が無ければ枠として扱わない */
function parseWindow(value: unknown): UsageWindow | null {
  if (!value || typeof value !== 'object') return null
  const o = value as Record<string, unknown>
  const percent = num(o.used_percent)
  if (percent === null) return null
  const window: UsageWindow = {
    // 手元の値は 59.0 のような小数。0〜100 に収める（外から来た値をそのまま画面の幅に使うので）
    used_percent: Math.min(100, Math.max(0, percent)),
    window_minutes: num(o.window_minutes) ?? 0,
  }
  const resets = num(o.resets_at)
  if (resets !== null && resets > 0) window.resets_at = resets
  return window
}

/**
 * Codex の rollout の 1 行 → 使用量。`{"type":"event_msg","payload":{"type":"token_count","rate_limits":{...}}}`。
 * token_count でない行、rate_limits の無い行（枠を返さない応答もある）は null。
 */
export function parseCodexUsage(line: unknown): CodexUsage | null {
  if (!line || typeof line !== 'object') return null
  const row = line as Record<string, unknown>
  if (row.type !== 'event_msg') return null
  const payload = row.payload as Record<string, unknown> | undefined
  if (!payload || typeof payload !== 'object' || payload.type !== 'token_count') return null
  const limits = payload.rate_limits as Record<string, unknown> | undefined
  if (!limits || typeof limits !== 'object') return null
  const primary = parseWindow(limits.primary)
  if (!primary) return null
  const usage: CodexUsage = { primary, at: typeof row.timestamp === 'string' ? row.timestamp : '' }
  const secondary = parseWindow(limits.secondary)
  if (secondary) usage.secondary = secondary
  if (typeof limits.plan_type === 'string' && limits.plan_type) usage.plan = limits.plan_type
  return usage
}

/**
 * Claude の transcript の 1 行 → 上限に当たった記録。`quotaLimits` が `status: "rejected"` のときだけ。
 * 空の `{}`（普段の行）と、既に戻っている（resetsAt が過ぎた）ものは null。**割合はここには無い**
 */
export function parseClaudeUsage(line: unknown, now: number): ClaudeUsage | null {
  if (!line || typeof line !== 'object') return null
  const row = line as Record<string, unknown>
  const quota = row.quotaLimits as Record<string, unknown> | undefined
  if (!quota || typeof quota !== 'object') return null
  if (quota.status !== 'rejected') return null
  const resets = num(quota.resetsAt)
  // 戻る時刻が無い・もう過ぎている記録は、いまの状態ではないので出さない
  if (resets === null || resets * 1000 <= now) return null
  return {
    limited: { resets_at: resets, kind: typeof quota.rateLimitType === 'string' ? quota.rateLimitType : '' },
    at: typeof row.timestamp === 'string' ? row.timestamp : '',
  }
}

/**
 * ステータスラインの窓（`used_percentage` と epoch 秒の `resets_at`）→ `UsageWindow`。
 * **戻る時刻を過ぎていたら null**（次に Claude が動くまでファイルは更新されないので、古い割合をそのまま出さない）
 */
function parseStatusWindow(value: unknown, minutes: number, now: number): UsageWindow | null {
  if (!value || typeof value !== 'object') return null
  const o = value as Record<string, unknown>
  const percent = num(o.used_percentage)
  if (percent === null) return null
  const resets = num(o.resets_at)
  if (resets !== null && resets * 1000 <= now) return null
  const window: UsageWindow = { used_percent: Math.min(100, Math.max(0, percent)), window_minutes: minutes }
  if (resets !== null && resets > 0) window.resets_at = resets
  return window
}

/** `resets_at` の無い窓を信じる上限。ファイルが古いまま残っていても、いつまでも出さない */
export const STATUS_MAX_AGE_MS = 8 * 24 * 60 * 60 * 1000

/**
 * `usage-claude[.<host>].json`（feed/statusline.py が書く）→ 使用量。
 * `rate_limits` が空、窓が全部戻っている、`ts` が古すぎる（STATUS_MAX_AGE_MS）ものは null。
 */
export function parseStatusLineUsage(file: unknown, now: number): ClaudeUsage | null {
  if (!file || typeof file !== 'object') return null
  const row = file as Record<string, unknown>
  const at = typeof row.ts === 'string' ? row.ts : ''
  const written = Date.parse(at)
  if (Number.isNaN(written) || now - written > STATUS_MAX_AGE_MS) return null
  const limits = row.rate_limits
  if (!limits || typeof limits !== 'object') return null
  const l = limits as Record<string, unknown>
  const usage: ClaudeUsage = { at }
  const primary = parseStatusWindow(l.five_hour, FIVE_HOURS_MINUTES, now)
  const secondary = parseStatusWindow(l.seven_day, WEEK_MINUTES, now)
  if (primary) usage.primary = primary
  if (secondary) usage.secondary = secondary
  return primary || secondary ? usage : null
}

/**
 * 出どころの違う 2 つを 1 つにする。割合はステータスライン、`limited` は transcript からしか来ないので、
 * 取れた方をそのまま重ねる。`at`（いつ時点か）は**割合の時刻を優先**する（画面のゲージの脇に出るのがそれ）
 */
export function mergeClaudeUsage(fromStatusLine: ClaudeUsage | null, fromTranscript: ClaudeUsage | null): ClaudeUsage | null {
  if (!fromStatusLine) return fromTranscript
  if (!fromTranscript) return fromStatusLine
  return { ...fromStatusLine, limited: fromTranscript.limited }
}

/** 枠の長さの言い換え。手元にある 300 / 10080 だけ名前を付け、他は分のまま */
export function windowLabel(minutes: number): string {
  if (minutes === FIVE_HOURS_MINUTES) return '5時間'
  if (minutes === WEEK_MINUTES) return '週'
  if (minutes <= 0) return ''
  if (minutes % 1440 === 0) return `${minutes / 1440}日`
  if (minutes % 60 === 0) return `${minutes / 60}時間`
  return `${minutes}分`
}

/** 上限の種類（Claude の rateLimitType）の言い換え。知らない値はそのまま出す */
export function limitKindLabel(kind: string): string {
  if (kind === 'five_hour') return '5時間'
  if (kind === 'weekly' || kind === 'seven_day') return '週'
  return kind
}

const pad = (n: number) => String(n).padStart(2, '0')

/**
 * 戻る時刻の言い換え。`resets_at` は epoch 秒。1 時間を切ったら残り、それより先は時刻（同じ日でなければ日付も）。
 * now は呼ぶ側から渡す（描画中に Date.now() を呼ばない）
 */
export function resetLabel(resetsAt: number, now: number): string {
  const at = new Date(resetsAt * 1000)
  if (Number.isNaN(at.getTime())) return ''
  const left = at.getTime() - now
  if (left <= 0) return 'まもなく戻る'
  const minutes = Math.ceil(left / 60000)
  if (minutes < 60) return `あと${minutes}分`
  const today = new Date(now)
  const sameDay = at.getFullYear() === today.getFullYear() && at.getMonth() === today.getMonth() && at.getDate() === today.getDate()
  const clock = `${pad(at.getHours())}:${pad(at.getMinutes())}`
  return sameDay ? `${clock} に戻る` : `${at.getMonth() + 1}/${at.getDate()} ${clock} に戻る`
}
