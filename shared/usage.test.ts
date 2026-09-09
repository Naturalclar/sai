import { test } from 'node:test'
import assert from 'node:assert/strict'
import { limitKindLabel, parseClaudeUsage, parseCodexUsage, resetLabel, usageLevel, windowLabel } from './usage.ts'

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
  assert.deepEqual(parseClaudeUsage(REJECTED, now), { resets_at: 1788509400, kind: 'five_hour', at: '2026-09-04T04:58:57.115Z' })
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
