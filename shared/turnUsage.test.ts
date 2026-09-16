import { test } from 'node:test'
import assert from 'node:assert/strict'
import { USAGE_MATCH_MS, failureTail, parseTurnUsage, totalTokens, usageByRow } from './turnUsage.ts'
import type { TurnUsageEntry } from './turnUsage.ts'
import type { FeedRow } from './types.ts'

/** 実測の形（`claude -p --model haiku --output-format json` の 1 行。長いキーは落としてある） */
const RESULT = JSON.stringify({
  type: 'result',
  subtype: 'success',
  is_error: false,
  duration_ms: 1297,
  duration_api_ms: 1921,
  num_turns: 1,
  result: 'ok',
  session_id: '4c5b0832-1da9-4b1a-8759-802bec8e6167',
  total_cost_usd: 0.0197672,
  permission_denials: [],
  usage: { input_tokens: 10, cache_creation_input_tokens: 8431, cache_read_input_tokens: 17582, output_tokens: 39 },
  modelUsage: { 'claude-haiku-4-5-20251001': { inputTokens: 907, costUSD: 0.0197672 } },
})

test('parseTurnUsage: result の行からトークン・費用・モデルを取る', () => {
  const u = parseTurnUsage(RESULT)
  assert.ok(u)
  assert.equal(u.model, 'claude-haiku-4-5-20251001')
  assert.equal(u.input_tokens, 10)
  assert.equal(u.output_tokens, 39)
  assert.equal(u.cache_read_input_tokens, 17582)
  assert.equal(u.cache_creation_input_tokens, 8431)
  assert.equal(u.cost_usd, 0.0197672)
  assert.equal(u.num_turns, 1)
  assert.equal(u.denials, 0)
  assert.equal(u.is_error, false)
  assert.equal(totalTokens(u), 10 + 39 + 17582 + 8431)
})

test('parseTurnUsage: 前に別の出力があっても末尾の result を取る（警告・reply.log の見出し）', () => {
  // stdin を閉じていても CLI が警告を出すことがある（実測）。reply.log には SAI の見出しの行も入る
  const log = ['--- 2026-09-16T00:00:00.000Z A@r claude ["-p"] (cwd /tmp)', 'Warning: no stdin data received in 3s, proceeding without it.', RESULT].join('\n')
  assert.equal(parseTurnUsage(log)?.output_tokens, 39)
})

test('parseTurnUsage: stream-json（本文の行が先に並ぶ）でも最後の result を取る', () => {
  const stream = [
    JSON.stringify({ type: 'system', subtype: 'init', session_id: 'x' }),
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'ok' }] } }),
    RESULT,
  ].join('\n')
  assert.equal(parseTurnUsage(stream)?.cost_usd, 0.0197672)
})

test('parseTurnUsage: result が無ければ null（--output-format を付けていない返信・空・壊れた行）', () => {
  assert.equal(parseTurnUsage('ok\nそのままのテキスト'), null)
  assert.equal(parseTurnUsage(''), null)
  assert.equal(parseTurnUsage('{"type":"assistant","message":{}}'), null, 'usage も費用も無い JSON は result ではない')
  assert.equal(parseTurnUsage('{壊れた'), null)
})

test('parseTurnUsage: 断られたツールの数を数える', () => {
  const denied = JSON.stringify({ ...JSON.parse(RESULT), permission_denials: [{ tool_name: 'Bash' }, { tool_name: 'Write' }], is_error: true })
  const u = parseTurnUsage(denied)
  assert.equal(u?.denials, 2)
  assert.equal(u?.is_error, true)
})

test('failureTail: JSON をそのまま出さず、CLI の本文（と断られた数）を出す', () => {
  const denied = JSON.stringify({ ...JSON.parse(RESULT), result: '許可されていないため実行できませんでした', permission_denials: [{ tool_name: 'Bash' }] })
  assert.equal(failureTail(denied), '許可されていないため実行できませんでした（未許可で断られたツール 1 件）')
})

test('failureTail: result が読めなければ元の文字列のまま（呼び出し側が末尾を切る）', () => {
  assert.equal(failureTail('command not found: claude'), 'command not found: claude')
  // 本文が空の result は、生の JSON を出すよりましな情報が無いので元のまま返す
  const empty = JSON.stringify({ ...JSON.parse(RESULT), result: '' })
  assert.equal(failureTail(empty), empty)
})

// ---- usageByRow（#411。どの行のぶんの使用量か） ----

/** 記録の行の最小形。`ts` はローカルのオフセット付き（record.py は秒に丸める） */
const row = (ts: string, session = 'S', event = 'Stop'): FeedRow =>
  ({ ts, agent: 'claude', repo: 'r', branch: '', session, session_source: 'payload', cwd: '/w', event, text: 'ok' }) as FeedRow

const entry = (ts: string, id = 'S@r', over: Partial<TurnUsageEntry> = {}): TurnUsageEntry => ({
  ts,
  id,
  model: 'claude-opus-5',
  input_tokens: 10,
  output_tokens: 39,
  cache_read_input_tokens: 0,
  cache_creation_input_tokens: 0,
  cost_usd: 0.01,
  duration_ms: 1000,
  num_turns: 1,
  denials: 0,
  is_error: false,
  ...over,
})

test('usageByRow: 行の 1〜2 秒あとにできた使用量を、その行に当てる（時刻で比べる。行は +09:00、使用量は Z）', () => {
  const rows = [row('2026-09-16T13:57:11+09:00')]
  const got = usageByRow(rows, [entry('2026-09-16T04:57:12.500Z', 'S@r', { output_tokens: 94 })])
  assert.equal(got.size, 1)
  assert.equal(got.get('S@r|2026-09-16T13:57:11+09:00')?.output_tokens, 94)
})

test('usageByRow: 次のターンのぶんは前のバブルに付かない（後の行のほうに当たる）', () => {
  const rows = [row('2026-09-16T13:57:11+09:00'), row('2026-09-16T13:57:41+09:00')]
  const got = usageByRow(rows, [entry('2026-09-16T04:57:42.500Z', 'S@r', { output_tokens: 222 })])
  assert.equal(got.size, 1)
  assert.equal(got.get('S@r|2026-09-16T13:57:41+09:00')?.output_tokens, 222)
  assert.equal(got.get('S@r|2026-09-16T13:57:11+09:00'), undefined)
})

test('usageByRow: 行より前にできた使用量は当てない（向きは「行 → 使用量」で決まっている）', () => {
  const rows = [row('2026-09-16T13:57:11+09:00')]
  assert.equal(usageByRow(rows, [entry('2026-09-16T04:57:10.000Z')]).size, 0)
})

test('usageByRow: 離れすぎた使用量は当てない（行を書かずに終わったターンのぶんを 1 つ前に付けない）', () => {
  const rows = [row('2026-09-16T13:57:11+09:00')]
  const late = new Date(Date.parse('2026-09-16T04:57:11Z') + USAGE_MATCH_MS + 1000).toISOString()
  assert.equal(usageByRow(rows, [entry(late)]).size, 0)
  const inside = new Date(Date.parse('2026-09-16T04:57:11Z') + USAGE_MATCH_MS - 1000).toISOString()
  assert.equal(usageByRow(rows, [entry(inside)]).size, 1)
})

test('usageByRow: 1 つの行に 2 つ当たったら先に来たほうを採る', () => {
  const rows = [row('2026-09-16T13:57:11+09:00')]
  const got = usageByRow(rows, [entry('2026-09-16T04:57:30.000Z', 'S@r', { output_tokens: 2 }), entry('2026-09-16T04:57:12.500Z', 'S@r', { output_tokens: 1 })])
  assert.equal(got.get('S@r|2026-09-16T13:57:11+09:00')?.output_tokens, 1)
})

test('usageByRow: 別のセッション・ターン完了でない行には当てない', () => {
  const other = usageByRow([row('2026-09-16T13:57:11+09:00', 'OTHER')], [entry('2026-09-16T04:57:12.500Z')])
  assert.equal(other.size, 0)
  const waiting = usageByRow([row('2026-09-16T13:57:11+09:00', 'S', 'PermissionRequest')], [entry('2026-09-16T04:57:12.500Z')])
  assert.equal(waiting.size, 0)
})

test('usageByRow: 読めない ts は落とす（空のときは何もしない）', () => {
  assert.equal(usageByRow([row('2026-09-16T13:57:11+09:00')], []).size, 0)
  assert.equal(usageByRow([row('ぐちゃぐちゃ')], [entry('2026-09-16T04:57:12.500Z')]).size, 0)
  assert.equal(usageByRow([row('2026-09-16T13:57:11+09:00')], [entry('ぐちゃぐちゃ')]).size, 0)
})
