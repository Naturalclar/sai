import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  limitKindLabel,
  mergeClaudeUsage,
  parseClaudeUsage,
  parseCodexUsage,
  parseStatusLineUsage,
  resetLabel,
  windowExpired,
  isUsageStale,
  lastRateLimitEvent,
  mergeUsageWindows,
  parseRateLimitEvent,
  STATUS_MAX_AGE_MS,
  USAGE_HIGH,
  USAGE_STALE_MS,
  USAGE_WARN,
  usageAgeLabel,
  usageAtLabel,
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
  // 過ぎた時刻（#726）: 数分までは「まもなく」、それより前は戻った時刻を言う（2 日前に「まもなく」と言わない）
  assert.equal(resetLabel(local(2026, 9, 9, 9, 58), now), 'まもなく戻る', '過ぎて 2 分')
  assert.equal(resetLabel(local(2026, 9, 9, 9, 55), now), 'まもなく戻る', '過ぎてちょうど 5 分')
  assert.equal(resetLabel(local(2026, 9, 9, 9, 0), now), '09:00 に戻った', '過ぎて 1 時間')
  assert.equal(resetLabel(local(2026, 9, 7, 15, 38), now), '9/7 15:38 に戻った', '過ぎて 2 日')
  // 「更新待ち」の脇で使う言い方: 過ぎた直後でも「まもなく」と言わない
  assert.equal(resetLabel(local(2026, 9, 9, 9, 58), now, { past: true }), '09:58 に戻った')
  assert.equal(resetLabel(local(2026, 9, 9, 10, 42), now, { past: true }), 'あと42分', 'まだ先の時刻は変わらない')
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

test('parseStatusLineUsage: 書く側（feed/statusline.py）と同じ境界で期限切れにする（#683）', () => {
  // feed/test_statusline.py の test_live_windows_boundary_matches_the_reader と同じ形。片方だけ変えない
  const now = 1_800_000_000 * 1000
  const usage = parseStatusLineUsage(
    statusFile({
      ts: new Date(now).toISOString(),
      rate_limits: { five_hour: { used_percentage: 1, resets_at: 1_800_000_000 }, seven_day: { used_percentage: 2, resets_at: 1_800_000_001 } },
    }),
    now,
  )
  assert.equal(usage?.primary, undefined, 'ちょうど戻る時刻は期限切れ')
  assert.equal(usage?.secondary?.used_percent, 2)
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

test('古さ: 30 分を過ぎたら古い。分からない時刻・先の時刻は古いと言わない（#694）', () => {
  const at = (ms: number) => new Date(NOW - ms).toISOString()
  assert.equal(isUsageStale(at(USAGE_STALE_MS), NOW), false, 'ちょうどはまだ')
  assert.equal(isUsageStale(at(USAGE_STALE_MS + 1), NOW), true)
  assert.equal(isUsageStale('', NOW), false)
  assert.equal(isUsageStale(undefined, NOW), false)
  assert.equal(isUsageStale('いつか', NOW), false)
  assert.equal(isUsageStale(at(-60_000), NOW), false, '時計がずれて先の時刻になっているもの')
  assert.equal(isUsageStale(at(3_600_000), 0), false, 'まだ取ってきていない（now が無い）')
})

test('古さの閾値は、捨てる上限より短く、色の境目の幅より先に付く（#694）', () => {
  // 30 分〜8 日は「古い」と印を付けて出し、8 日を過ぎたものは parseStatusLineUsage() が出さない
  assert.ok(USAGE_STALE_MS < STATUS_MAX_AGE_MS)
  const old = statusFile({ ts: new Date(NOW - USAGE_STALE_MS - 60_000).toISOString() })
  const usage = parseStatusLineUsage(old, NOW)
  assert.ok(usage, '古くても 8 日までは出す')
  assert.equal(isUsageStale(usage.at, NOW), true)
  // 根拠にした実測の進み（30 分で 10 ポイント）が、色の境目の幅（15 ポイント）に収まること
  assert.ok((USAGE_STALE_MS / (30 * 60_000)) * 10 < USAGE_HIGH - USAGE_WARN)
})

test('どれだけ前か・いつ時点かの言い換え（今日でなければ日付も）（#694）', () => {
  const at = (ms: number) => new Date(NOW - ms).toISOString()
  assert.equal(usageAgeLabel(at(30_000), NOW), '')
  assert.equal(usageAgeLabel(at(45 * 60_000), NOW), '45分前')
  assert.equal(usageAgeLabel(at(27 * 3_600_000 + 5 * 60_000), NOW), '27時間前')
  assert.equal(usageAgeLabel(at(47 * 3_600_000), NOW), '47時間前')
  assert.equal(usageAgeLabel(at(3 * 86_400_000), NOW), '3日前')
  assert.equal(usageAgeLabel('', NOW), '')
  const d = new Date(NOW - 45 * 60_000)
  const clock = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  assert.equal(usageAtLabel(d.toISOString(), NOW), `${clock} 時点`)
  const y = new Date(NOW - 27 * 3_600_000)
  assert.match(usageAtLabel(y.toISOString(), NOW), new RegExp(`^${y.getMonth() + 1}/${y.getDate()} \\d\\d:\\d\\d 時点$`))
  assert.equal(usageAtLabel('', NOW), '')
})

// ---- SAI から回した返信の出力に載る使用率（#694）
/** 手元の reply.log（`claude -p --output-format stream-json`、2.1.287）から取った実物の形 */
const limitEvent = (five: number, week: number, fiveResets = 1791269400, weekResets = 1791392400) => ({
  type: 'rate_limit_event',
  rate_limit_info: {
    status: 'allowed',
    resetsAt: fiveResets,
    rateLimitType: 'five_hour',
    overageStatus: 'rejected',
    isUsingOverage: false,
    unifiedWindows: { five_hour: { utilization: five, resetsAt: fiveResets }, seven_day: { utilization: week, resetsAt: weekResets } },
  },
  uuid: '45344eae',
  session_id: 'S1',
})

test('rate_limit_event: 5 時間と週の割合を usage-claude.json と同じ形にする（0〜1 → %）', () => {
  assert.deepEqual(parseRateLimitEvent(limitEvent(0.14, 0.6)), {
    five_hour: { used_percentage: 14, resets_at: 1791269400 },
    seven_day: { used_percentage: 60, resets_at: 1791392400 },
  })
  assert.equal(parseRateLimitEvent(limitEvent(0, 1.2))?.seven_day?.used_percentage, 100, '100 を超えない')
  assert.deepEqual(parseRateLimitEvent(limitEvent(0, 0.61))?.five_hour, { used_percentage: 0, resets_at: 1791269400 }, '0% も値')
  // 割合の載っていない知らせ・別の行・壊れた形は読まない
  assert.equal(parseRateLimitEvent({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed' } }), null)
  assert.equal(parseRateLimitEvent({ type: 'rate_limit_event', rate_limit_info: { unifiedWindows: { five_hour: { utilization: 'x' } } } }), null)
  assert.equal(parseRateLimitEvent({ type: 'assistant', rate_limit_info: limitEvent(0.1, 0.2).rate_limit_info }), null)
  assert.equal(parseRateLimitEvent(null), null)
})

test('rate_limit_event: 出力のかたまりから最後のものを採る（ほかの行・書きかけの行は飛ばす）', () => {
  const text = [
    JSON.stringify({ type: 'assistant', message: { content: '"rate_limit_event" という文字を含む本文' } }),
    JSON.stringify(limitEvent(0.13, 0.6)),
    '--- 2026-10-06T05:00:00.000Z A@r 何か',
    JSON.stringify(limitEvent(0.14, 0.61)),
    '{"type":"rate_limit_event","rate_limit_info":{"unifiedWin',
  ].join('\n')
  assert.deepEqual(lastRateLimitEvent(text), { five_hour: { used_percentage: 14, resets_at: 1791269400 }, seven_day: { used_percentage: 61, resets_at: 1791392400 } })
  assert.equal(lastRateLimitEvent('{"type":"result"}\n'), null)
  assert.equal(lastRateLimitEvent(''), null)
})

test('割合の 2 つの出どころをまとめる: 返信が新しければ丸ごと、ステータスラインが新しければ窓ごと（#694）', () => {
  const w = (used: number, minutes: number, resets?: number) => ({ used_percent: used, window_minutes: minutes, ...(resets ? { resets_at: resets } : {}) })
  const R5 = 1791269400
  const R7 = 1791392400
  const replies = { at: '2026-10-06T14:00:00+09:00', primary: w(2, 300, R5), secondary: w(61, 10080, R7) }
  assert.equal(mergeUsageWindows(null, replies), replies)
  assert.equal(mergeUsageWindows(null, null), null)

  // 実測の形: ステータスラインは 10/5 の週 37% だけ → 返信を丸ごと
  const old = { at: '2026-10-05T10:57:58+09:00', secondary: w(37, 10080, R7) }
  assert.equal(mergeUsageWindows(old, replies), replies)
  assert.equal(mergeUsageWindows(old, null), old)
  // 返信が新しければ、ステータスラインのほうが高くても・窓を余分に持っていても混ぜない
  // （枠が途中でリセットされて下がった・端数の違い・古い 5 時間の窓を「いま」として出さない）
  const higher = { at: '2026-10-06T11:00:00+09:00', primary: w(80, 300, R5), secondary: w(62, 10080, R7) }
  assert.equal(mergeUsageWindows(higher, replies), replies)
  // 返信に無い窓だけはステータスラインから（黙って消さない）。混ぜたときの時刻は古いほう
  assert.deepEqual(mergeUsageWindows(higher, { at: replies.at, secondary: replies.secondary }), { at: higher.at, primary: w(80, 300, R5), secondary: w(61, 10080, R7) })
  assert.equal(mergeUsageWindows({ ...higher, at: replies.at }, replies), replies, '同じ時刻なら返信')

  // ステータスラインのほうが新しい: 端末で使って進んだ値はそちら
  const tui = { at: '2026-10-06T14:30:00+09:00', primary: w(5, 300, R5 + 3), secondary: w(63, 10080, R7) }
  assert.deepEqual(mergeUsageWindows(tui, replies), tui)
  // 同じ窓で返信より低いものは、古い値を持ち回っている端末が書いたもの → 返信のほう。全部そうなら返信を丸ごと
  const carried = { at: '2026-10-06T14:30:00+09:00', secondary: w(40, 10080, R7 + 5) }
  assert.equal(mergeUsageWindows(carried, replies), replies)
  // 片方の窓だけ端末が進めた: 混ぜたときの時刻は古いほう（返信）の時刻。新しく見せない
  const half = { at: '2026-10-06T14:30:00+09:00', primary: w(9, 300, R5), secondary: w(40, 10080, R7) }
  assert.deepEqual(mergeUsageWindows(half, replies), { at: replies.at, primary: w(9, 300, R5), secondary: w(61, 10080, R7) })
  // 端末に無い窓は返信から（時刻は返信）
  assert.deepEqual(mergeUsageWindows({ at: '2026-10-06T14:30:00+09:00', secondary: w(70, 10080, R7) }, replies), { at: replies.at, primary: w(2, 300, R5), secondary: w(70, 10080, R7) })
  // 戻る時刻が先へ進んでいれば新しい窓なので、低くても端末のほう
  const next = { at: '2026-10-06T15:00:00+09:00', primary: w(1, 300, R5 + 18000), secondary: w(61, 10080, R7) }
  assert.deepEqual(mergeUsageWindows(next, replies), next)
})

// ---- 復帰時刻を過ぎた枠（#726）
test('windowExpired: 復帰時刻を過ぎた枠だけ。時刻が無い・now が無いなら過ぎたと言わない', () => {
  const now = local(2026, 9, 9, 10, 0) * 1000
  assert.equal(windowExpired({ resets_at: local(2026, 9, 9, 9, 59) }, now), true)
  assert.equal(windowExpired({ resets_at: local(2026, 9, 9, 10, 0) }, now), true, 'ちょうど')
  assert.equal(windowExpired({ resets_at: local(2026, 9, 9, 10, 1) }, now), false)
  assert.equal(windowExpired({}, now), false)
  assert.equal(windowExpired(undefined, now), false)
  assert.equal(windowExpired({ resets_at: local(2026, 9, 9, 9, 0) }, 0), false)
})
