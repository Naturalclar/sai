import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  limitKindLabel,
  mergeClaudeUsage,
  parseClaudeUsage,
  parseCodexUsage,
  parseStatusLineUsage,
  resetLabel,
  STATUS_MAX_AGE_MS,
  usageLevel,
  windowLabel,
} from './usage.ts'

/** 手元の rollout（~/.codex/sessions/2026/09/...）から取った実物の形 */
const CODEX_LINE = {
  timestamp: '2026-09-09T08:39:28.618Z',
  type: 'event_msg',
  payload: {
    type: 'token_count',
    info: { total_token_usage: { input_tokens: 1 }, model_context_window: 258400 },
    rate_limits: {
      limit_id: 'codex',
      limit_name: null,
      primary: { used_percent: 59.0, window_minutes: 300, resets_at: 1788956513 },
      secondary: { used_percent: 20.0, window_minutes: 10080, resets_at: 1789454706 },
      credits: { has_credits: false, unlimited: false, balance: '0' },
      individual_limit: null,
      spend_control_reached: null,
      plan_type: 'plus',
      rate_limit_reached_type: null,
    },
  },
}

test('parseCodexUsage: 実物の token_count の行から 5時間と週の枠を読む', () => {
  const usage = parseCodexUsage(CODEX_LINE)
  assert.deepEqual(usage, {
    primary: { used_percent: 59, window_minutes: 300, resets_at: 1788956513 },
    secondary: { used_percent: 20, window_minutes: 10080, resets_at: 1789454706 },
    plan: 'plus',
    at: '2026-09-09T08:39:28.618Z',
  })
})

test('parseCodexUsage: token_count 以外・rate_limits の無い行は null', () => {
  assert.equal(parseCodexUsage({ type: 'response_item', payload: { type: 'message' } }), null)
  assert.equal(parseCodexUsage({ type: 'event_msg', payload: { type: 'agent_message' } }), null)
  assert.equal(parseCodexUsage({ type: 'event_msg', payload: { type: 'token_count', info: {} } }), null, 'rate_limits が無いことがある')
  assert.equal(parseCodexUsage({ type: 'event_msg', payload: { type: 'token_count', rate_limits: {} } }), null, 'primary が無ければ枠にならない')
  assert.equal(parseCodexUsage(null), null)
  assert.equal(parseCodexUsage('token_count'), null)
})

test('parseCodexUsage: secondary / plan_type / resets_at はあれば載せる（無くても primary だけで返す）', () => {
  const usage = parseCodexUsage({
    type: 'event_msg',
    payload: { type: 'token_count', rate_limits: { primary: { used_percent: 12.5, window_minutes: 300 } } },
  })
  assert.deepEqual(usage, { primary: { used_percent: 12.5, window_minutes: 300 }, at: '' })
})

test('parseCodexUsage: 割合は 0〜100 に収める（画面の幅にそのまま使う）', () => {
  const over = parseCodexUsage({ type: 'event_msg', payload: { type: 'token_count', rate_limits: { primary: { used_percent: 140, window_minutes: 300 } } } })
  assert.equal(over?.primary.used_percent, 100)
  const under = parseCodexUsage({ type: 'event_msg', payload: { type: 'token_count', rate_limits: { primary: { used_percent: -3, window_minutes: 300 } } } })
  assert.equal(under?.primary.used_percent, 0)
})

/** 手元の transcript にあった唯一の空でない quotaLimits（弾かれた 1 件） */
const REJECTED = {
  timestamp: '2026-09-04T04:58:57.115Z',
  type: 'assistant',
  quotaLimits: {
    status: 'rejected',
    resetsAt: 1788509400,
    unifiedRateLimitFallbackAvailable: false,
    rateLimitType: 'five_hour',
    overageStatus: 'rejected',
    isUsingOverage: false,
  },
}

test('parseClaudeUsage: rejected でまだ戻っていなければ、戻る時刻と種類を返す', () => {
  const now = 1788509400 * 1000 - 60_000 // 戻る 1 分前
  assert.deepEqual(parseClaudeUsage(REJECTED, now), {
    limited: { resets_at: 1788509400, kind: 'five_hour' },
    at: '2026-09-04T04:58:57.115Z',
  })
})

test('parseClaudeUsage: 戻ったあとの記録は「いまの状態」ではないので null', () => {
  assert.equal(parseClaudeUsage(REJECTED, 1788509400 * 1000 + 1), null)
})

test('parseClaudeUsage: 普段の行（quotaLimits が空 / allowed）は null', () => {
  const now = Date.parse('2026-09-04T00:00:00Z')
  assert.equal(parseClaudeUsage({ type: 'assistant', quotaLimits: {} }, now), null)
  assert.equal(parseClaudeUsage({ type: 'assistant' }, now), null)
  assert.equal(parseClaudeUsage({ quotaLimits: { status: 'allowed', resetsAt: 9999999999 } }, now), null)
  assert.equal(parseClaudeUsage({ quotaLimits: { status: 'rejected' } }, now), null, 'resetsAt が無ければ出せない')
  assert.equal(parseClaudeUsage(null, now), null)
})

test('usageLevel: 80% から warn、95% から high', () => {
  assert.equal(usageLevel(0), 'ok')
  assert.equal(usageLevel(79.9), 'ok')
  assert.equal(usageLevel(80), 'warn')
  assert.equal(usageLevel(94.9), 'warn')
  assert.equal(usageLevel(95), 'high')
  assert.equal(usageLevel(100), 'high')
})

test('windowLabel: 300 は 5時間、10080 は週', () => {
  assert.equal(windowLabel(300), '5時間')
  assert.equal(windowLabel(10080), '週')
  assert.equal(windowLabel(1440), '1日')
  assert.equal(windowLabel(120), '2時間')
  assert.equal(windowLabel(45), '45分')
  assert.equal(windowLabel(0), '')
})

test('limitKindLabel: 知らない種類はそのまま出す', () => {
  assert.equal(limitKindLabel('five_hour'), '5時間')
  assert.equal(limitKindLabel('weekly'), '週')
  assert.equal(limitKindLabel('opus_weekly'), 'opus_weekly')
  assert.equal(limitKindLabel(''), '')
})

// 時刻の表示はプロセスの地方時なので、期待値も地方時で組む（CI は UTC で回る）
const local = (y: number, m: number, d: number, hh: number, mm: number) => Math.floor(new Date(y, m - 1, d, hh, mm, 0, 0).getTime() / 1000)

test('resetLabel: 1時間未満は残り、それより先は時刻。日をまたぐなら日付も', () => {
  const now = local(2026, 9, 9, 10, 0) * 1000
  assert.equal(resetLabel(local(2026, 9, 9, 10, 42), now), 'あと42分')
  assert.equal(resetLabel(local(2026, 9, 9, 13, 30), now), '13:30 に戻る')
  assert.equal(resetLabel(local(2026, 9, 11, 9, 5), now), '9/11 09:05 に戻る')
  assert.equal(resetLabel(local(2026, 9, 9, 9, 0), now), 'まもなく戻る', '過ぎている')
  assert.equal(resetLabel(Number.NaN, now), '')
})

// ---- ステータスライン経由の割合（#250）。feed/statusline.py が書くファイルの中身
const NOW = Date.parse('2026-09-10T01:00:00+09:00')
const statusFile = (over: Record<string, unknown> = {}) => ({
  v: 1,
  ts: '2026-09-10T00:59:00+09:00',
  host: 'mbp',
  session: 'S1',
  model: 'claude-opus-5',
  rate_limits: {
    five_hour: { used_percentage: 42.7, resets_at: Math.floor(NOW / 1000) + 3600 },
    seven_day: { used_percentage: 71, resets_at: Math.floor(NOW / 1000) + 86400 },
  },
  ...over,
})

test('parseStatusLineUsage: 5時間と週を Codex と同じ UsageWindow に寄せる', () => {
  assert.deepEqual(parseStatusLineUsage(statusFile(), NOW), {
    at: '2026-09-10T00:59:00+09:00',
    primary: { used_percent: 42.7, window_minutes: 300, resets_at: Math.floor(NOW / 1000) + 3600 },
    secondary: { used_percent: 71, window_minutes: 10080, resets_at: Math.floor(NOW / 1000) + 86400 },
  })
})

test('parseStatusLineUsage: 戻る時刻を過ぎた枠は出さない（次に Claude が動くまでファイルは更新されない）', () => {
  const past = statusFile({
    rate_limits: {
      five_hour: { used_percentage: 90, resets_at: Math.floor(NOW / 1000) - 1 },
      seven_day: { used_percentage: 71, resets_at: Math.floor(NOW / 1000) + 86400 },
    },
  })
  const usage = parseStatusLineUsage(past, NOW)
  assert.equal(usage?.primary, undefined, '5時間の枠はもう戻っている')
  assert.equal(usage?.secondary?.used_percent, 71)
  // 全部戻っていれば、そのファイルは何も語らない
  assert.equal(parseStatusLineUsage(statusFile({ rate_limits: { five_hour: { used_percentage: 90, resets_at: Math.floor(NOW / 1000) - 1 } } }), NOW), null)
})

test('parseStatusLineUsage: 古すぎるファイル・rate_limits の無いファイル・壊れた値は null', () => {
  assert.equal(parseStatusLineUsage(statusFile({ ts: new Date(NOW - STATUS_MAX_AGE_MS - 1).toISOString() }), NOW), null, '古すぎる')
  assert.equal(parseStatusLineUsage(statusFile({ ts: 'いつ？' }), NOW), null, '時刻が読めない')
  assert.equal(parseStatusLineUsage(statusFile({ rate_limits: {} }), NOW), null, 'subscription でなければ rate_limits は空')
  assert.equal(parseStatusLineUsage(statusFile({ rate_limits: { five_hour: { used_percentage: 'たくさん' } } }), NOW), null)
  assert.equal(parseStatusLineUsage(null, NOW), null)
})

test('parseStatusLineUsage: resets_at が無くても割合は出す（0〜100 に収める）', () => {
  const usage = parseStatusLineUsage(statusFile({ rate_limits: { five_hour: { used_percentage: 120 } } }), NOW)
  assert.deepEqual(usage?.primary, { used_percent: 100, window_minutes: 300 })
})

test('mergeClaudeUsage: 割合（ステータスライン）と上限中（transcript）は出どころが違うので重ねる', () => {
  const windows = parseStatusLineUsage(statusFile(), NOW)!
  const limited = { limited: { resets_at: Math.floor(NOW / 1000) + 60, kind: 'five_hour' }, at: '2026-09-10T00:30:00+09:00' }
  const merged = mergeClaudeUsage(windows, limited)
  assert.equal(merged?.primary?.used_percent, 42.7)
  assert.deepEqual(merged?.limited, limited.limited)
  assert.equal(merged?.at, windows.at, 'いつ時点かは割合の時刻（ゲージの脇に出るのがそれ）')
  // 片方しか無いことの方が多い
  assert.equal(mergeClaudeUsage(windows, null), windows)
  assert.equal(mergeClaudeUsage(null, limited), limited)
  assert.equal(mergeClaudeUsage(null, null), null)
})
