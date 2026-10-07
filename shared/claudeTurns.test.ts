import { test } from 'node:test'
import assert from 'node:assert/strict'
import { claudeTurns, findTurn, worthParsing } from './claudeTurns.ts'
import { readFileSync } from 'node:fs'

const T0 = Date.parse('2026-10-01T02:34:40.000Z')
const at = (s: number) => new Date(T0 + s * 1000).toISOString()
const user = (s: number, content: unknown, over: Record<string, unknown> = {}) => JSON.stringify({ type: 'user', timestamp: at(s), message: { role: 'user', content }, ...over })
const said = (s: number, text: string, stop: string | null) => JSON.stringify({ type: 'assistant', timestamp: at(s), message: { role: 'assistant', content: [{ type: 'text', text }], stop_reason: stop } })
const tool = (s: number) => JSON.stringify({ type: 'assistant', timestamp: at(s), message: { role: 'assistant', content: [{ type: 'tool_use', id: 't', name: 'Bash', input: {} }], stop_reason: 'tool_use' } })
const result = (s: number) => user(s, [{ type: 'tool_result', tool_use_id: 't', content: 'ok' }])

const lines = [
  said(-100, '読んだ範囲の前から続いているターンの返答', 'end_turn'),
  user(0, '#583 に着手して'),
  said(5, '調べます', 'tool_use'),
  tool(6),
  result(7),
  said(600, '#583 は PR #610 です', 'end_turn'),
  user(700, [{ type: 'text', text: 'マージして' }]),
  user(701, 'メタの行', { isMeta: true }),
  tool(710),
  result(711),
  said(720, '途中の地の文', 'tool_use'),
]

test('claudeTurns: 人の入力で区切り、そのターンのいちばん新しい本文と、閉じたかを取る。前のターンには遡らない（#614）', () => {
  const turns = claudeTurns(lines)
  assert.equal(turns.length, 2, '読んだ範囲の頭の、始まりの見えないターンは捨てる')
  assert.deepEqual([turns[0]!.input, turns[0]!.text, turns[0]!.closed, turns[0]!.endedAt, turns[0]!.over], ['#583 に着手して', '#583 は PR #610 です', true, at(600), true])
  assert.deepEqual([turns[1]!.input, turns[1]!.text, turns[1]!.closed, turns[1]!.over], ['マージして', '途中の地の文', false, false], '閉じていないターンは closed にしない')
  assert.deepEqual(claudeTurns(['こわれた行', '', '{"type":"user"}']), [])
})

test('claudeTurns: サブエージェントの行・ツールの戻りだけの行・要約の行は入力にしない', () => {
  const turns = claudeTurns([user(0, '指示'), user(1, 'サブの入力', { isSidechain: true }), result(2), user(3, '要約', { isCompactSummary: true }), said(4, '返答', 'end_turn')])
  assert.equal(turns.length, 1)
  assert.equal(turns[0]!.text, '返答')
})

test('findTurn: 入力の行の時刻に近いターンだけを返す。近いものが無ければ null（別のターンの返答を出さない）', () => {
  const turns = claudeTurns(lines)
  assert.equal(findTurn(turns, { startMs: T0 + 400 })?.text, '#583 は PR #610 です', '行の ts は秒までなのでずれを許す')
  assert.equal(findTurn(turns, { startMs: T0 + 60_000 }), null)
  assert.equal(findTurn(turns, { startMs: T0 + 700_000 })?.closed, false)
  const twin = claudeTurns([user(0, 'A の指示'), said(1, 'A の返答', 'end_turn'), user(3, 'B の指示'), said(4, 'B の返答', 'end_turn')])
  assert.equal(findTurn(twin, { startMs: T0 + 2000, input: 'B の指示' })?.text, 'B の返答', '近いものが 2 つあれば入力の頭が同じ方')
  assert.equal(findTurn(twin, { startMs: T0 + 500 })?.text, 'A の返答', '入力が分からなければ一番近い方')
})

test('findTurn: 本文が空のターン完了の行は、その少し前に終わったターンに当てる', () => {
  const turns = claudeTurns(lines)
  assert.equal(findTurn(turns, { endMs: T0 + 610_000 })?.text, '#583 は PR #610 です')
  assert.equal(findTurn(turns, { endMs: T0 + 300_000 }), null, 'その頃に終わったターンが無い')
  assert.equal(findTurn(turns, {}), null)
})

test('worthParsing: 落とすのはツールの戻りと本文の無い assistant の行だけ。落としても結果は変わらない', () => {
  assert.equal(worthParsing(result(1)), false)
  assert.equal(worthParsing(tool(1)), false)
  assert.equal(worthParsing(user(0, '指示')), true)
  assert.equal(worthParsing(said(1, '返答', 'end_turn')), true)
  assert.equal(worthParsing(user(0, 'これは "type":"tool_result" の話')), true, '本文の中の文字列は JSON ではエスケープされているので当たらない')
  assert.deepEqual(claudeTurns(lines.filter(worthParsing)), claudeTurns(lines))
})

// `feed/test_record.py`（`_is_prompt_row()` が u1・u2 だけ）と `shared/progress.test.ts` が同じファイルを読む（#626）
test('claudeTurns: 要約の行（isCompactSummary）を入力にしない — record.py と同じ transcript で突き合わせる（#626）', () => {
  const lines = readFileSync(new URL('./testdata/compact-transcript.ndjson', import.meta.url), 'utf8').split('\n').filter(Boolean)
  const turns = claudeTurns(lines)
  assert.deepEqual(turns.map((t) => t.input), ['最初の指示', '次の指示'], '要約の文は入力にならない')
  assert.equal(turns[1]?.text, '要約のあとの返答', '要約をまたいでも同じターンの返答')
})

test('claudeTurns: ログイン切れで CLI が出した文（error: authentication_failed）には authFailed を付ける。あとに本物の返答が続けば外す（#577）', () => {
  // 実物の形（2.1.292）: モデルは <synthetic>、行の頭に error と isApiErrorMessage、stop_reason は stop_sequence
  const failed = (s: number) =>
    JSON.stringify({ type: 'assistant', timestamp: at(s), error: 'authentication_failed', isApiErrorMessage: true, message: { role: 'assistant', model: '<synthetic>', content: [{ type: 'text', text: 'Not logged in · Please run /login' }], stop_reason: 'stop_sequence' } })
  const [stopped] = claudeTurns([user(0, '続けて'), said(5, '途中の文', 'tool_use'), failed(60)])
  assert.deepEqual([stopped!.text, stopped!.closed, stopped!.authFailed], ['Not logged in · Please run /login', true, true])
  const [resumed] = claudeTurns([user(0, '続けて'), failed(60), said(90, '終わりました', 'end_turn')])
  assert.deepEqual([resumed!.text, resumed!.authFailed], ['終わりました', undefined])
  assert.equal(claudeTurns([user(0, '続けて'), said(5, 'Not logged in · Please run /login', 'end_turn')])[0]!.authFailed, undefined, '文言では決めない（行の error で決める）')
})
