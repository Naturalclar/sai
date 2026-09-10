import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  claudeProgress,
  claudeProjectName,
  codexProgress,
  codexToolSummary,
  oneLine,
  progressActive,
  progressDuration,
  PROGRESS_IDLE_MS,
  PROGRESS_SUMMARY_MAX,
  PROGRESS_TOOL_MAX_MS,
  stepLabel,
  stepsSince,
} from './progress.ts'
import type { ProgressStep } from './types.ts'

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
  assert.deepEqual(claudeProgress(['', '{ broken', 'null', '[]']), { steps: [], started: false, open: false })
})

const ev = (ts: string, payload: Record<string, unknown>) => j({ timestamp: ts, type: 'event_msg', payload })
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
