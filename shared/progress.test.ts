import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  claudeProgress,
  claudeProjectName,
  codexProgress,
  codexToolSummary,
  oneLine,
  opencodeContext,
  progressActive,
  progressDuration,
  PROGRESS_IDLE_MS,
  PROGRESS_SUMMARY_MAX,
  PROGRESS_TOOL_MAX_MS,
  notesSince,
  PROGRESS_NOTE_MAX,
  stepLabel,
  stepsSince,
} from './progress.ts'
import type { ProgressStep } from './types.ts'
import { readFileSync } from 'node:fs'

const j = (o: unknown) => JSON.stringify(o)
const T = (s: number) => new Date(Date.UTC(2026, 8, 10, 12, 0, s)).toISOString()
const prompt = (ts: string, text: string, extra: Record<string, unknown> = {}) => j({ type: 'user', timestamp: ts, message: { role: 'user', content: text }, ...extra })
const assistant = (ts: string, blocks: unknown[], stop: string) => j({ type: 'assistant', timestamp: ts, message: { role: 'assistant', content: blocks, stop_reason: stop } })
const result = (ts: string, id: string) => j({ type: 'user', timestamp: ts, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] }, toolUseResult: {} })

test('claudeProgress: 人の入力からターンが始まり、走っている間は tool_use だけがある。結果が来たら終わり、end_turn で閉じる', () => {
  const lines = [
    prompt(T(0), '前のターン'),
    assistant(T(1), [{ type: 'tool_use', id: 'old', name: 'Read', input: { file_path: '/x' } }], 'tool_use'),
    result(T(2), 'old'),
    assistant(T(3), [{ type: 'text', text: '終わり' }], 'end_turn'),
    prompt(T(10), 'テストを回して'),
    assistant(T(11), [{ type: 'thinking', thinking: '' }], 'tool_use'),
    assistant(T(11), [{ type: 'text', text: 'テストを回します\n2 行目' }], 'tool_use'),
    assistant(T(12), [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'pnpm test', description: 'テストを回す' } }], 'tool_use'),
  ]
  let p = claudeProgress(lines)
  assert.equal(p.started, true)
  assert.equal(p.open, true)
  assert.deepEqual(
    p.steps,
    [
      { kind: 'thinking', summary: '', started: T(11), ended: T(11) },
      { kind: 'text', summary: 'テストを回します', started: T(11), ended: T(11) },
      { kind: 'tool', tool: 'Bash', summary: 'テストを回す', started: T(12) },
    ],
    '前のターンの手順は入らない。本文は 1 行目だけ。Bash は description を出す',
  )

  p = claudeProgress([...lines, result(T(40), 't1'), assistant(T(41), [{ type: 'text', text: '通りました' }], 'end_turn')])
  assert.equal(p.open, false)
  assert.equal(p.steps[2]?.ended, T(40))
  assert.equal(p.steps.length, 4)
})

test('claudeProgress: description が無ければ許可待ちと同じ要約。考え中が続けば 1 手順。サブエージェント・isMeta・要約の行ではターンを切らない', () => {
  const p = claudeProgress([
    prompt(T(0), 'やって'),
    prompt(T(1), '<system-reminder>…', { isMeta: true }),
    assistant(T(2), [{ type: 'thinking', thinking: '' }], 'tool_use'),
    assistant(T(3), [{ type: 'thinking', thinking: '' }], 'tool_use'),
    j({ type: 'assistant', isSidechain: true, timestamp: T(4), message: { content: [{ type: 'tool_use', id: 's', name: 'Grep', input: { pattern: 'x' } }], stop_reason: 'tool_use' } }),
    assistant(T(5), [{ type: 'tool_use', id: 'r', name: 'Read', input: { file_path: '/repo/a.ts' } }], 'tool_use'),
    prompt(T(6), 'This session is being continued', { isCompactSummary: true }),
  ])
  assert.deepEqual(
    p.steps.map((s) => [s.kind, s.tool ?? '', s.summary]),
    [
      ['thinking', '', ''],
      ['tool', 'Read', '/repo/a.ts'],
    ],
  )
  assert.equal(p.steps[0]?.ended, T(3), '続いた考え中は 1 手順にまとめて、終わりを延ばす')
})

test('claudeProgress: 始まりが読んだ範囲に無くても、最後の assistant の stop_reason で開いているか分かる。壊れた行は飛ばす', () => {
  const mid = claudeProgress([assistant(T(1), [{ type: 'tool_use', id: 'a', name: 'Bash', input: { command: 'sleep 100' } }], 'tool_use')])
  assert.equal(mid.started, false)
  assert.equal(mid.open, true)
  assert.equal(mid.steps.length, 1)
  assert.equal(claudeProgress([assistant(T(1), [{ type: 'text', text: 'done' }], 'end_turn')]).open, false)
  assert.deepEqual(claudeProgress(['', '{ broken', 'null', '[]']), { steps: [], started: false, open: false, context: 0, notes: [] })
})

test('claudeProgress / codexProgress: 最後にモデルを呼んだときに読んだ量（送ると相手が読み直す量。#311）', () => {
  const withUsage = (ts: string, stop: string, usage: Record<string, number>) =>
    j({ type: 'assistant', timestamp: ts, message: { role: 'assistant', content: [{ type: 'text', text: 'x' }], stop_reason: stop, usage } })
  const claude = claudeProgress([
    prompt(T(0), 'やって'),
    withUsage(T(1), 'tool_use', { input_tokens: 10, cache_read_input_tokens: 500_000, cache_creation_input_tokens: 2_000, output_tokens: 99 }),
    withUsage(T(2), 'end_turn', { input_tokens: 5, cache_read_input_tokens: 510_000, cache_creation_input_tokens: 1_000, output_tokens: 7 }),
    j({ type: 'assistant', timestamp: T(3), isSidechain: true, message: { role: 'assistant', content: [], usage: { input_tokens: 9_999_999 } } }),
  ])
  assert.equal(claude.context, 511_005, '一番新しい呼び出しの入力。出力とサブエージェントは足さない')
  assert.equal(claudeProgress([prompt(T(0), 'やって')]).context, 0, '読んだ範囲に無ければ 0')

  const codex = codexProgress([
    ev(T(0), { type: 'task_started', turn_id: 'a' }),
    ev(T(1), { type: 'token_count', info: { last_token_usage: { input_tokens: 40_000, cached_input_tokens: 6_400, output_tokens: 10 }, total_token_usage: { input_tokens: 700_000 } } }),
    ev(T(2), { type: 'token_count', info: { last_token_usage: { input_tokens: 53_807, cached_input_tokens: 6_400 } } }),
    ev(T(3), { type: 'token_count', info: null }),
  ])
  assert.equal(codex.context, 53_807, 'last_token_usage（1 回ぶん。total は積算なので使わない）。info の無い行では上書きしない')
})

const ev = (ts: string, payload: Record<string, unknown>) => j({ timestamp: ts, type: 'event_msg', payload })

test('claudeProgress / codexProgress: 要約で縮んだら古い量を残さない（#441 のレビュー。縮めたあとも「大きすぎる」が出続けた）', () => {
  const usage = (ts: string, n: number) => j({ type: 'assistant', timestamp: ts, message: { role: 'assistant', content: [{ type: 'text', text: 'x' }], stop_reason: 'end_turn', usage: { input_tokens: 0, cache_read_input_tokens: n } } })
  const boundary = (ts: string, post?: number) => j({ type: 'system', subtype: 'compact_boundary', timestamp: ts, content: 'Conversation compacted', compactMetadata: { trigger: 'manual', preTokens: 966_519, ...(post === undefined ? {} : { postTokens: post }) } })
  assert.equal(claudeProgress([prompt(T(0), 'やって'), usage(T(1), 966_519), boundary(T(2), 23_981)]).context, 23_981, '縮んだあとの量')
  assert.equal(claudeProgress([prompt(T(0), 'やって'), usage(T(1), 966_519), boundary(T(2))]).context, 0, '量が書かれていなければ「分からない」')
  assert.equal(claudeProgress([prompt(T(0), 'やって'), usage(T(1), 966_519), boundary(T(2), 23_981), usage(T(3), 30_000)]).context, 30_000, '次に呼んだらその量')

  const tokens = (ts: string, n: number) => ev(ts, { type: 'token_count', info: { last_token_usage: { input_tokens: n } } })
  const compacted = (ts: string) => j({ timestamp: ts, type: 'compacted', payload: { message: '', replacement_history: [] } })
  assert.equal(codexProgress([tokens(T(0), 231_121), compacted(T(1)), tokens(T(2), 0)]).context, 0, '縮んだあとは次の量が来るまで「分からない」')
  assert.equal(codexProgress([tokens(T(0), 231_121), compacted(T(1)), tokens(T(2), 25_382)]).context, 25_382)
})

const item = (ts: string, payload: Record<string, unknown>) => j({ timestamp: ts, type: 'response_item', payload })

test('codexProgress: task_started でターンが始まり、exec の cmd / function_call の command を拾い、task_complete で閉じる', () => {
  const lines = [
    ev(T(0), { type: 'task_started', turn_id: 'a' }),
    item(T(1), { type: 'custom_tool_call', call_id: 'c0', name: 'exec', input: 'x' }),
    ev(T(2), { type: 'task_complete', turn_id: 'a' }),
    ev(T(10), { type: 'task_started', turn_id: 'b' }),
    item(T(11), { type: 'reasoning', summary: [], encrypted_content: 'xx' }),
    item(T(12), { type: 'custom_tool_call', call_id: 'c1', name: 'exec', input: 'const r = await tools.exec_command({"cmd":"pnpm test -- \\"a b\\"","yield_time_ms":1000})' }),
    item(T(13), { type: 'function_call', call_id: 'c2', name: 'shell', arguments: j({ command: ['bash', '-lc', 'git status'] }) }),
    item(T(14), { type: 'function_call_output', call_id: 'c2', output: 'clean' }),
  ]
  let p = codexProgress(lines)
  assert.equal(p.started, true)
  assert.equal(p.open, true)
  assert.deepEqual(
    p.steps.map((s) => [s.kind, s.tool ?? '', s.summary, s.ended ?? '']),
    [
      ['thinking', '', '', T(11)],
      ['tool', 'exec', 'pnpm test -- "a b"', ''],
      ['tool', 'shell', 'git status', T(14)],
    ],
  )
  p = codexProgress([...lines, item(T(20), { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '通りました' }] }), ev(T(21), { type: 'task_complete', turn_id: 'b' })])
  assert.equal(p.open, false)
  assert.deepEqual(p.steps.at(-1), { kind: 'text', summary: '通りました', started: T(20), ended: T(20) })
})

test('codexToolSummary: 分からない形は空（コードや JSON をそのまま出さない）', () => {
  assert.equal(codexToolSummary('{"cell_id":"5","yield_time_ms":30000}'), '')
  assert.equal(codexToolSummary(''), '')
  assert.equal(codexToolSummary(1), '')
  assert.equal(codexToolSummary('const x = 1'), '')
  assert.equal(codexToolSummary('{"path":"/a/b"}'), '/a/b')
  assert.equal(codexToolSummary('{"cmd":"line1\\nline2"}'), 'line1')
})

test('progressActive: 閉じたら動いていない。開いていても、走っているツールが無く書き込みが古ければ止まっている', () => {
  const now = Date.parse(T(0)) + 60 * 60_000
  const open = (steps: ProgressStep[]) => ({ steps, started: true, open: true })
  assert.equal(progressActive({ steps: [], started: true, open: false }, now, now), false, '閉じたターン')
  assert.equal(progressActive(open([]), now - 1000, now), true, '書き込みが新しい')
  assert.equal(progressActive(open([]), now - PROGRESS_IDLE_MS - 1, now), false, 'Esc で止めたまま古くなった')
  const running: ProgressStep = { kind: 'tool', tool: 'Bash', summary: '', started: new Date(now - 30 * 60_000).toISOString() }
  assert.equal(progressActive(open([running]), now - PROGRESS_IDLE_MS - 1, now), true, '長いコマンドの間は書き込みが無くても走っている')
  const stale = { ...running, started: new Date(now - PROGRESS_TOOL_MAX_MS - 1).toISOString() }
  assert.equal(progressActive(open([stale]), now - PROGRESS_IDLE_MS - 1, now), false, 'tool_result が書かれないまま上限を超え、書き込みも古い')
  assert.equal(progressActive(open([{ ...running, ended: T(0) }]), now - PROGRESS_IDLE_MS - 1, now), false, '終わったツールは走っていない')
})

test('stepLabel / progressDuration / stepsSince / claudeProjectName / oneLine', () => {
  assert.equal(stepLabel({ kind: 'tool', tool: 'Bash', summary: 'pnpm test', started: '' }), 'Bash: pnpm test')
  assert.equal(stepLabel({ kind: 'tool', tool: 'mcp__github__issue_read', summary: '', started: '' }), 'mcp__github__issue_read')
  assert.equal(stepLabel({ kind: 'thinking', summary: '', started: '' }), '考え中')
  assert.equal(stepLabel({ kind: 'text', summary: '直しました', started: '' }), '返答: 直しました')

  const t0 = Date.parse(T(0))
  assert.equal(progressDuration(T(0), t0 + 42_000), '42秒')
  assert.equal(progressDuration(T(0), t0 + 190_000), '3分10秒')
  assert.equal(progressDuration(T(0), t0 + 3_900_000), '1時間5分')
  assert.equal(progressDuration('x', t0), '')
  assert.equal(progressDuration(T(10), t0), '0秒', '時計のずれで負になっても 0')

  const steps: ProgressStep[] = [
    { kind: 'tool', tool: 'Read', summary: '', started: T(0) },
    { kind: 'tool', tool: 'Bash', summary: '', started: T(30) },
  ]
  assert.deepEqual(stepsSince(steps, T(20)).map((s) => s.tool), ['Bash'], '送る前に始まった手順（前のターン）は落とす')
  assert.deepEqual(stepsSince(steps, T(5)).map((s) => s.tool), ['Read', 'Bash'], '記録のずれの幅は残す')
  assert.equal(stepsSince(steps, '').length, 2)

  assert.equal(claudeProjectName('/Users/me/.ghq/github.com/o/r.git/dev-a'), '-Users-me--ghq-github-com-o-r-git-dev-a')
  assert.equal(oneLine('\n  a  \nb'), 'a')
  const long = oneLine('あ'.repeat(PROGRESS_SUMMARY_MAX + 50))
  assert.equal(Array.from(long).length, PROGRESS_SUMMARY_MAX)
  assert.ok(long.endsWith('…'))
})

test('claudeProgress: 返事の付いていない AskUserQuestion を question に持つ。答え・新しい入力で消え、サブエージェントの中は見ない（#333）', () => {
  const input = { questions: [{ question: '赤か青か?', header: '色', options: [{ label: '赤' }, { label: '青' }] }] }
  const ask = (ts: string, id: string, given: unknown = input, extra: Record<string, unknown> = {}) =>
    j({ type: 'assistant', timestamp: ts, message: { role: 'assistant', content: [{ type: 'tool_use', id, name: 'AskUserQuestion', input: given }], stop_reason: 'tool_use' }, ...extra })
  const lines = [prompt(T(0), '色を決めて'), ask(T(1), 'q1')]

  assert.deepEqual(claudeProgress(lines).question, { input, asked_at: T(1), text: '質問: 赤か青か?' }, '文は待ちの行（record.py）と同じ形')
  assert.equal(claudeProgress([...lines, result(T(5), 'q1')]).question, undefined, '答えた')
  assert.equal(claudeProgress([...lines, result(T(5), 'other')]).question?.asked_at, T(1), '別のツールの結果では消えない')
  assert.equal(claudeProgress([...lines, prompt(T(6), '別の話')]).question, undefined, '新しいターン')
  assert.equal(claudeProgress([prompt(T(0), 'やって'), ask(T(1), 'q9', input, { isSidechain: true })]).question, undefined, 'サブエージェントの中')
  const two = { questions: [{ question: 'A?' }, { question: 'B?' }] }
  assert.equal(claudeProgress([...lines, result(T(2), 'q1'), ask(T(3), 'q2', two)]).question?.text, '質問: A? / B?', '一番新しいもの')
  assert.equal(codexProgress([j({ type: 'event_msg', payload: { type: 'task_started' } })]).question, undefined, 'Codex には無い')
})

test('opencodeContext: 一番新しい、入力の量が 0 でない返答の入力 3 つの和（#396）', () => {
  const reply = (input: number, read = 0, write = 0) => ({ info: { role: 'assistant', tokens: { input, output: 9, reasoning: 0, cache: { read, write } } }, parts: [] })
  assert.equal(opencodeContext([reply(100), { info: { role: 'user' } }, reply(12749, 5, 3)]), 12757)
  assert.equal(opencodeContext([reply(100), { info: { role: 'user' } }, reply(0)]), 100, '書いている最中（全部 0）の返答は飛ばす')
  assert.equal(opencodeContext([{ info: { role: 'user' } }]), 0, '返答がまだ無ければ 0')
  assert.equal(opencodeContext({ data: [] }), 0, '形が違えば 0（v2 の /context の形）')
  assert.equal(opencodeContext([{ info: { role: 'assistant', tokens: { input: 'x' } } }]), 0)
})

// 「人の入力か」の判定が記録の側（feed/record.py）とずれないように、同じ transcript を読ませる（#626）。
// `feed/test_record.py` の `test_compact_summary_row_is_not_a_prompt_same_fixture_as_shared_tests` と、`shared/claudeTurns.test.ts` が同じファイルを読む
test('claudeProgress: 要約の行（isCompactSummary）でターンを切らない — record.py と同じ transcript で突き合わせる（#626）', () => {
  const lines = readFileSync(new URL('./testdata/compact-transcript.ndjson', import.meta.url), 'utf8').split('\n').filter(Boolean)
  const p = claudeProgress(lines)
  // 要約の行（s1）で切っていれば、要約より前の手順（u2 のターンの思考・地の文・Read）が消える
  assert.deepEqual(
    p.steps.map((s) => [s.kind, s.tool ?? '', s.summary]),
    [
      ['thinking', '', ''],
      ['text', '', '要約の前の地の文'],
      ['tool', 'Read', '/repo/a.ts'],
      ['text', '', '要約のあとの返答'],
    ],
  )
  assert.equal(p.started, true)
  assert.equal(p.open, false)
})

test('途中の文（#680）: Codex は commentary だけを全文で持ち、final_answer と phase の無い文は入れない。ツールに押し出されない', () => {
  const say = (ts: string, text: string, phase?: string) => item(ts, { type: 'message', role: 'assistant', content: [{ type: 'output_text', text }], ...(phase ? { phase } : {}) })
  const long = `1 行目\n\n${'あ'.repeat(PROGRESS_NOTE_MAX + 50)}`
  const lines = [
    ev(T(0), { type: 'task_started', turn_id: 'a' }),
    say(T(1), '前のターンの途中の文', 'commentary'),
    ev(T(2), { type: 'task_complete', turn_id: 'a' }),
    ev(T(10), { type: 'task_started', turn_id: 'b' }),
    say(T(11), 'まず `server/app.ts` を読みます。\n原因を探します。', 'commentary'),
    ...Array.from({ length: 12 }, (_, i) => item(T(12), { type: 'function_call', call_id: `c${i}`, name: 'shell', arguments: j({ command: ['bash', '-lc', 'ls'] }) })),
    say(T(20), long, 'commentary'),
    say(T(21), 'phase の無い文'),
  ]
  let p = codexProgress(lines)
  assert.deepEqual(p.notes?.map((n) => n.at), [T(11), T(20)], '前のターンの文と phase の無い文は入れない')
  assert.equal(p.notes?.[0]?.text, 'まず `server/app.ts` を読みます。\n原因を探します。', '1 行に切らない')
  assert.equal(Array.from(p.notes?.[1]?.text ?? '').length, PROGRESS_NOTE_MAX, '長ければ切る')
  assert.equal(p.steps.filter((s) => s.kind === 'text').length, 2, '手順には今までどおり 1 行で入る（続いた文は 1 手順）')
  p = codexProgress([...lines, say(T(30), '直しました', 'final_answer'), ev(T(31), { type: 'task_complete', turn_id: 'b' })])
  assert.deepEqual(p.notes?.map((n) => n.at), [T(11), T(20)], '最後の返答は途中の文にしない（行として届く）')
  assert.deepEqual(notesSince(p.notes ?? [], T(40)).length, 0, '送った時刻より前の文は落とす')
  assert.deepEqual(notesSince(p.notes ?? [], T(25)).map((n) => n.at), [T(20)])
})

test('途中の文（#680）: Claude はツールの合間の文。続いた文は 1 つに繋ぎ、閉じたターンの最後の文（返答）は入れない', () => {
  const said = (ts: string, text: string, stop: string) => j({ type: 'assistant', timestamp: ts, message: { role: 'assistant', content: [{ type: 'text', text }], stop_reason: stop } })
  const use = (ts: string, id: string) => j({ type: 'assistant', timestamp: ts, message: { role: 'assistant', content: [{ type: 'tool_use', id, name: 'Bash', input: { command: 'ls' } }], stop_reason: 'tool_use' } })
  const lines = [
    prompt(T(0), '前のターン'),
    said(T(1), '前のターンの文', 'tool_use'),
    prompt(T(10), '直して'),
    said(T(11), '読みます。', 'tool_use'),
    said(T(12), '続きの文。', 'tool_use'),
    use(T(13), 't1'),
    j({ type: 'assistant', isSidechain: true, timestamp: T(14), message: { role: 'assistant', content: [{ type: 'text', text: 'サブエージェントの文' }] } }),
    said(T(15), '原因が分かりました。', 'tool_use'),
  ]
  let p = claudeProgress(lines)
  assert.deepEqual(p.notes, [{ text: '読みます。\n\n続きの文。', at: T(11) }, { text: '原因が分かりました。', at: T(15) }])
  p = claudeProgress([...lines, use(T(16), 't2'), said(T(20), '直しました。', 'end_turn')])
  assert.equal(p.open, false)
  assert.deepEqual(p.notes?.map((n) => n.text), ['読みます。\n\n続きの文。', '原因が分かりました。'], '閉じたターンの最後の文は返答そのもの')
})

test('codexProgress: ターンの始まり（task_started）の時刻を返す。新しいターンが始まれば新しい方（#693）', () => {
  const ev = (timestamp: string, type: string) => JSON.stringify({ timestamp, type: 'event_msg', payload: { type } })
  const open = codexProgress([ev('2026-10-05T03:00:00.000Z', 'task_started'), ev('2026-10-05T03:01:00.000Z', 'task_complete'), ev('2026-10-05T03:05:00.123Z', 'task_started')])
  assert.equal(open.open, true)
  assert.equal(open.since, '2026-10-05T03:05:00.123Z')
  const closed = codexProgress([ev('2026-10-05T03:00:00.000Z', 'task_started'), ev('2026-10-05T03:01:00.000Z', 'task_complete')])
  assert.equal(closed.open, false)
  assert.equal(codexProgress([ev('2026-10-05T03:01:00.000Z', 'task_complete')]).since, undefined, '始まりを見ていない（途中から読んだ）')
  // 人が止めたターンは task_complete を書かず turn_aborted で終わる（#695 のレビュー。見ないと止めたターンが「処理中」のまま）
  const aborted = codexProgress([ev('2026-10-05T03:00:00.000Z', 'task_started'), ev('2026-10-05T03:02:00.000Z', 'turn_aborted')])
  assert.equal(aborted.open, false)
  assert.equal(aborted.closed, '2026-10-05T03:02:00.000Z')
  assert.equal(closed.closed, '2026-10-05T03:01:00.000Z')
  assert.equal(open.closed, undefined, '新しいターンが始まったら閉じた時刻は持たない')
})
