import { test } from 'node:test'
import assert from 'node:assert/strict'
import { CONTEXT_WARN_TOKENS } from './contextSize.ts'
import { usageReport, usageReportDays, withTurnCosts } from './usageReport.ts'
import type { TurnUsageEntry } from './turnUsage.ts'

const NOW = Date.parse('2026-10-02T12:00:00+09:00')

const entry = (id: string, ts: string, over: Partial<TurnUsageEntry> = {}): TurnUsageEntry => ({
  ts,
  id,
  model: 'claude-opus-5',
  input_tokens: 10,
  output_tokens: 20,
  cache_read_input_tokens: 1000,
  cache_creation_input_tokens: 100,
  cost_usd: 1,
  duration_ms: 1000,
  num_turns: 1,
  denials: 0,
  is_error: false,
  ...over,
})

test('usageReportDays: 選べるのは 1 / 7 / 30。知らない値は 7 日', () => {
  assert.equal(usageReportDays('1'), 1)
  assert.equal(usageReportDays('30'), 30)
  assert.equal(usageReportDays(null), 7)
  assert.equal(usageReportDays('90'), 7)
  assert.equal(usageReportDays('-1'), 7)
  assert.equal(usageReportDays('abc'), 7)
})

test('usageReport: 0 件のときは全部 0 で、割合で割り算しない', () => {
  const r = usageReport([], { now: NOW, days: 7 })
  assert.equal(r.total.turns, 0)
  assert.equal(r.total.tokens, 0)
  assert.equal(r.total.cost_usd, 0)
  assert.deepEqual(r.sessions, [])
  assert.deepEqual(r.by_day, [])
  assert.deepEqual(r.by_model, [])
  assert.equal(r.since, new Date(NOW - 7 * 24 * 60 * 60_000).toISOString())
})

test('usageReport: 期間で切る（境目ちょうどは含む。先の時刻は入れない）', () => {
  const entries = [
    entry('A@r', new Date(NOW - 24 * 60 * 60_000 - 1).toISOString()),
    entry('A@r', new Date(NOW - 24 * 60 * 60_000).toISOString()),
    entry('A@r', new Date(NOW - 1000).toISOString()),
    entry('A@r', new Date(NOW + 1000).toISOString()),
  ]
  assert.equal(usageReport(entries, { now: NOW, days: 1 }).total.turns, 2)
  assert.equal(usageReport(entries, { now: NOW, days: 7 }).total.turns, 3)
})

test('usageReport: セッション別・日別・モデル別の合計と割合。トークンは 4 つを分けて持つ', () => {
  const entries = [
    entry('A@r', '2026-10-02T01:00:00Z', { cost_usd: 3, denials: 2 }),
    entry('A@r', '2026-10-01T16:00:00Z', { output_tokens: 890, is_error: true }),
    // UTC では 9/30 だが、Asia/Tokyo では 10/1
    entry('B@r', '2026-09-30T15:30:00Z', { model: 'claude-haiku-4-5', cache_read_input_tokens: 0, cache_creation_input_tokens: 0, input_tokens: 500, output_tokens: 500 }),
    entry('C@r', '2026-09-30T01:00:00Z', { model: '' }),
  ]
  const r = usageReport(entries, { now: NOW, days: 7, names: new Map([['A@r', 'セッション C']]) })
  assert.deepEqual(r.total, { turns: 4, input_tokens: 530, output_tokens: 1430, cache_read_input_tokens: 3000, cache_creation_input_tokens: 300, tokens: 5260, cost_usd: 6, denials: 2, errors: 1 })

  // セッション別はトークンの多い順。名前は渡したものだけ
  assert.deepEqual(r.sessions.map((s) => [s.key, s.name, s.turns, s.tokens, s.cost_usd, s.denials, s.errors]), [
    ['A@r', 'セッション C', 2, 3130, 4, 2, 1],
    ['C@r', undefined, 1, 1130, 1, 0, 0],
    ['B@r', undefined, 1, 1000, 1, 0, 0],
  ])
  assert.equal(r.sessions[0]?.token_share, 3130 / 5260)
  assert.equal(r.sessions[0]?.cost_share, 4 / 6)
  assert.equal(r.sessions.reduce((n, s) => n + s.token_share, 0).toFixed(6), '1.000000')

  // 日別は新しい日から。日付は Asia/Tokyo
  assert.deepEqual(r.by_day.map((d) => [d.key, d.turns, d.tokens]), [
    ['2026-10-02', 2, 3130],
    ['2026-10-01', 1, 1000],
    ['2026-09-30', 1, 1130],
  ])

  // モデル別はトークンの多い順。分からないモデルは空の鍵
  assert.deepEqual(r.by_model.map((m) => [m.key, m.turns, m.tokens, m.cache_read_input_tokens]), [
    ['claude-opus-5', 2, 3130, 2000],
    ['', 1, 1130, 1000],
    ['claude-haiku-4-5', 1, 1000, 0],
  ])
})

test('usageReport: 読み直しが大きいセッションに印（読み直し ÷ CLI の中で回ったターン数が、コンテキストの注意と同じ区切り以上）', () => {
  const entries = [
    // 1 回の返信の中でモデルを 10 回呼んだ。返信の数（1）で割ると区切りを超えるが、呼んだ回数で割ると超えない
    entry('A@r', '2026-10-02T01:00:00Z', { cache_read_input_tokens: CONTEXT_WARN_TOKENS * 5, num_turns: 10 }),
    entry('B@r', '2026-10-02T01:00:00Z', { cache_read_input_tokens: CONTEXT_WARN_TOKENS * 2, num_turns: 2 }),
    // num_turns が 0 の行は 1 回として数える（0 で割らない）
    entry('C@r', '2026-10-02T01:00:00Z', { cache_read_input_tokens: 10, num_turns: 0 }),
  ]
  const r = usageReport(entries, { now: NOW, days: 7 })
  const by = new Map(r.sessions.map((s) => [s.key, s]))
  assert.equal(by.get('A@r')?.read_per_call, CONTEXT_WARN_TOKENS / 2)
  assert.equal(by.get('A@r')?.heavy, false)
  assert.equal(by.get('B@r')?.read_per_call, CONTEXT_WARN_TOKENS)
  assert.equal(by.get('B@r')?.heavy, true)
  assert.equal(by.get('C@r')?.read_per_call, 10)
})

test('usageReport: 壊れた行（ts が読めない・id が無い・数字でない値）は読み飛ばすか 0 として足す。知らないキーは無視する', () => {
  const entries = [
    entry('A@r', '2026-10-02T01:00:00Z'),
    entry('A@r', '壊れた時刻'),
    { ...entry('A@r', '2026-10-02T01:00:00Z'), id: undefined } as unknown as TurnUsageEntry,
    null as unknown as TurnUsageEntry,
    { ...entry('A@r', '2026-10-02T02:00:00Z'), input_tokens: 'たくさん', cost_usd: Number.NaN, extra: { nested: true } } as unknown as TurnUsageEntry,
  ]
  const r = usageReport(entries, { now: NOW, days: 7 })
  assert.equal(r.total.turns, 2)
  assert.equal(r.total.input_tokens, 10)
  assert.equal(r.total.cost_usd, 1)
})

test('withTurnCosts + usageReport: 費用は積み上げを足さず、前の行との差で数える。期間で切る前に差にする', () => {
  const entries = [
    // 期間の外。ここまでの積み上げ 50 を、期間の最初の行に乗せない
    entry('A@r', '2026-09-01T00:00:00Z', { cost_usd: 50 }),
    entry('A@r', '2026-10-01T00:00:00Z', { cost_usd: 52 }),
    entry('B@r', '2026-10-01T01:00:00Z', { cost_usd: 10 }),
    entry('A@r', '2026-10-02T00:00:00Z', { cost_usd: 55 }),
    // 数え直しで下がった行は、その値をそのまま
    entry('A@r', '2026-10-02T01:00:00Z', { cost_usd: 0.5 }),
  ]
  // 境目を 0 にして、どの行も積み上げとして読む
  const r = usageReport(withTurnCosts(entries, 0), { now: NOW, days: 7 })
  assert.equal(r.total.cost_usd, 2 + 10 + 3 + 0.5)
  assert.equal(usageReport(withTurnCosts(entries, 0), { now: NOW, days: 60 }).total.cost_usd, 50 + 2 + 10 + 3 + 0.5)
  // 既定の境目（9/19 14 時 JST）より前の行は、書かれた値のまま（1 ターンぶん）
  assert.equal(usageReport(withTurnCosts(entries), { now: NOW, days: 60 }).total.cost_usd, 50 + 52 + 10 + 3 + 0.5)
  assert.equal(r.sessions.find((s) => s.key === 'A@r')?.cost_usd, 5.5)
  // 差にしないと 117.5 になる
  assert.equal(usageReport(entries, { now: NOW, days: 7 }).total.cost_usd, 117.5)
  // 元の配列は書き換えない
  assert.equal(entries[1]?.cost_usd, 52)
})
