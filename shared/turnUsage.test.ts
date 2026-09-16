import { test } from 'node:test'
import assert from 'node:assert/strict'
import { failureTail, parseTurnUsage, totalTokens } from './turnUsage.ts'

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
