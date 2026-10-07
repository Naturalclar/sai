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

const pad = (n: number) => String(n).padStart(2, '0')

/** `usage-claude*.json` の `rate_limits` の形（`feed/statusline.py` が書くものと同じ） */
export type RateLimitWindows = Partial<Record<'five_hour' | 'seven_day', { used_percentage: number; resets_at?: number }>>

/**
 * `claude -p --output-format stream-json` の出力の 1 行 → 使用率の窓（#694）。`rate_limit_event` の
 * `rate_limit_info.unifiedWindows`（`utilization` は 0〜1、`resetsAt` は epoch 秒）だけを読む。
 * 割合の載っていない知らせ（古い CLI・窓が無い）は null
 */
export function parseRateLimitEvent(line: unknown): RateLimitWindows | null {
  if (!line || typeof line !== 'object') return null
  const row = line as Record<string, unknown>
  if (row.type !== 'rate_limit_event') return null
  const info = row.rate_limit_info as Record<string, unknown> | undefined
  const unified = info?.unifiedWindows as Record<string, unknown> | undefined
  if (!unified || typeof unified !== 'object') return null
  const out: RateLimitWindows = {}
  for (const name of ['five_hour', 'seven_day'] as const) {
    const w = unified[name] as Record<string, unknown> | undefined
    const used = w && typeof w === 'object' ? num(w.utilization) : null
    if (used === null || used < 0) continue
    const resets = num(w!.resetsAt)
    // 0〜1 を % に。浮動小数の端数（0.14 * 100 = 14.000000000000002）は落とす
    out[name] = { used_percentage: Math.min(100, Math.round(used * 10000) / 100), ...(resets !== null && resets > 0 ? { resets_at: resets } : {}) }
  }
  return out.five_hour || out.seven_day ? out : null
}

/** 出力のかたまりの中の、最後の `rate_limit_event`。無ければ null（並行する返信の行が混ざっていても、口座の値なので区別しない） */
export function lastRateLimitEvent(text: string): RateLimitWindows | null {
  if (!text.includes('"rate_limit_event"')) return null
  let found: RateLimitWindows | null = null
  for (const line of text.split('\n')) {
    if (!line.includes('"rate_limit_event"')) continue
    try {
      found = parseRateLimitEvent(JSON.parse(line)) ?? found
    } catch {
      // 書きかけの行
    }
  }
  return found
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
 * Claude の割合を「古い」と見なすまでの時間（#694）。値が届くのは Claude Code が API を呼んだときだけ:
 * 端末ならステータスライン（`usage-claude.json`）、SAI から回した返信なら出力の `rate_limit_event`（`usage-claude-replies.json`）。
 * どちらも動いていなければ値は進まない。
 * 測る起点は `ClaudeUsage.at`。**返信の出力から拾った値は「届いた時刻」、ステータスラインの値は「割合が最後に変わった時刻」**（#689）
 * なので、ステータスラインだけの人では届いているが変わっていない値（上限中の 100%・軽い利用）にも付く。画面は「◯ 前の値」としか言わない。
 * ステータスラインの側に「最後に届いた時刻」を持たないのは、API を叩いていない描き直しと区別が付かないため（#719 のレビュー）。
 *
 * 30 分にした根拠: 実測（2026-10-05）で、並行して回していた 30 分に週の割合が 37% → 47% と 10 ポイント進んでいた。
 * 色が変わる境目（`USAGE_WARN` 80 と `USAGE_HIGH` 95）の間が 15 ポイントなので、これより長く黙っていると色を 1 段取り違えうる。
 * 端末で使っているあいだは発言のたびに描かれて数分おきに届くので、ふつうに使っていて付くことはない。
 * **`STATUS_MAX_AGE_MS`（8 日）より必ず短い**: ここから 8 日までは「古い」と印を付けて出し、8 日を過ぎたら今までどおり出さない
 */
export const USAGE_STALE_MS = 30 * 60_000

/** その値が届いてからの時間（ミリ秒）。`at` が無い・読めない・先の時刻なら null（古いとは言わない） */
export function usageAgeMs(at: string | undefined, now: number): number | null {
  const written = Date.parse(at ?? '')
  if (Number.isNaN(written) || now <= 0) return null
  const age = now - written
  return age >= 0 ? age : null
}

/** 値が古いか（`USAGE_STALE_MS` より前に届いたまま）。いつの値か分からないものは古いと言わない */
export function isUsageStale(at: string | undefined, now: number, staleMs: number = USAGE_STALE_MS): boolean {
  const age = usageAgeMs(at, now)
  return age !== null && age > staleMs
}

/** どれだけ前の値か（「45分前」「27時間前」「3日前」）。1 分未満・分からないときは空 */
export function usageAgeLabel(at: string | undefined, now: number): string {
  const age = usageAgeMs(at, now)
  if (age === null) return ''
  const minutes = Math.floor(age / 60_000)
  if (minutes < 1) return ''
  if (minutes < 60) return `${minutes}分前`
  const hours = Math.floor(minutes / 60)
  return hours < 48 ? `${hours}時間前` : `${Math.floor(hours / 24)}日前`
}

/**
 * いつ時点の値か（「10:57 時点」。**今日でなければ日付も**「10/5 10:57 時点」）。時刻だけだと、きのうの値が今日の値に見える。
 * 読めなければ空
 */
export function usageAtLabel(at: string | undefined, now: number): string {
  const d = new Date(at ?? '')
  if (Number.isNaN(d.getTime())) return ''
  const today = new Date(now)
  const sameDay = d.getFullYear() === today.getFullYear() && d.getMonth() === today.getMonth() && d.getDate() === today.getDate()
  const clock = `${pad(d.getHours())}:${pad(d.getMinutes())}`
  return `${sameDay ? clock : `${d.getMonth() + 1}/${d.getDate()} ${clock}`} 時点`
}

/** `resets_at` の差がこの秒数以内なら同じ窓（`feed/statusline.py` の `SAME_WINDOW_SECONDS` と同じ） */
export const SAME_WINDOW_SECONDS = 60

/**
 * 割合の 2 つの出どころ（端末のステータスライン・SAI から回した返信の出力。#694）を 1 つにする。どちらも口座の値。
 *
 * **2 つは時刻の意味が違う**: 返信の `at` は「届いた時刻」（その時点の口座の値そのもの）、ステータスラインの `at` は
 * 「割合が最後に変わった時刻」で、古い値を持ち回っている端末が書いたものかもしれない。
 * - 返信のほうが新しい（同じ時刻も）→ **返信を丸ごと**（届いたばかりの値に、古いステータスラインの窓を混ぜない。
 *   枠が途中でリセットされて割合が下がったときも、返信の値が勝つ）
 * - ステータスラインのほうが新しい → 窓ごとにステータスラインを採る。ただし**同じ窓（`resets_at` の差が
 *   `SAME_WINDOW_SECONDS` 以内）で返信より低い**ものは持ち回りの古い値なので返信のほう。ステータスラインに無い窓も返信から
 * - `at` は、**出している窓のうち古いほうの出どころの時刻**（片方が古ければ古いと言う。新しく見せない）
 */
export function mergeUsageWindows(statusLine: ClaudeUsage | null, replies: ClaudeUsage | null): ClaudeUsage | null {
  if (!statusLine || !replies) return statusLine ?? replies
  if (!(Date.parse(statusLine.at) > Date.parse(replies.at))) return replies
  const carried = (s: UsageWindow | undefined, r: UsageWindow | undefined): boolean =>
    !!s && !!r && s.resets_at !== undefined && r.resets_at !== undefined && Math.abs(s.resets_at - r.resets_at) <= SAME_WINDOW_SECONDS && s.used_percent < r.used_percent
  const fromStatus = (s: UsageWindow | undefined, r: UsageWindow | undefined): boolean => !!s && !carried(s, r)
  const primaryStatus = fromStatus(statusLine.primary, replies.primary)
  const secondaryStatus = fromStatus(statusLine.secondary, replies.secondary)
  if (!primaryStatus && !secondaryStatus) return replies
  const primary = primaryStatus ? statusLine.primary : replies.primary
  const secondary = secondaryStatus ? statusLine.secondary : replies.secondary
  const usedReplies = (!primaryStatus && !!replies.primary) || (!secondaryStatus && !!replies.secondary)
  const out: ClaudeUsage = { at: usedReplies ? replies.at : statusLine.at }
  if (primary) out.primary = primary
  if (secondary) out.secondary = secondary
  return out
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
