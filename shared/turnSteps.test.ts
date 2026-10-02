import { test } from 'node:test'
import assert from 'node:assert/strict'
import { toolSummary } from './approvals.ts'
import { TURN_STEP_TEXT_MAX, claudeStepParser, codexStepParser, findStepTurn, skipForSteps, stepCounts } from './turnSteps.ts'

const T0 = Date.parse('2026-10-02T01:00:00.000Z')
const at = (s: number) => new Date(T0 + s * 1000).toISOString()
const user = (s: number, content: unknown, over: Record<string, unknown> = {}) => JSON.stringify({ type: 'user', timestamp: at(s), message: { role: 'user', content }, ...over })
const use = (s: number, name: string, input: Record<string, unknown>) => JSON.stringify({ type: 'assistant', timestamp: at(s), message: { role: 'assistant', content: [{ type: 'tool_use', id: `t${s}`, name, input }], stop_reason: 'tool_use' } })
const result = (s: number) => user(s, [{ type: 'tool_result', tool_use_id: 't', content: '秘密の出力 SECRET=abc' }])
const said = (s: number, text: string) => JSON.stringify({ type: 'assistant', timestamp: at(s), message: { role: 'assistant', content: [{ type: 'text', text }], stop_reason: 'end_turn' } })

const claude = [
  use(-50, 'Bash', { command: '読み始めより前のターンの手順' }),
  user(0, '#605 に着手して'),
  use(5, 'Bash', { command: 'pnpm test', description: 'テストを回す' }),
  result(6),
  use(7, 'Edit', { file_path: '/w/server/app.ts', old_string: 'a', new_string: 'b' }),
  result(8),
  use(9, 'Task', { description: '探す', prompt: '探して' }),
  user(10, 'サブエージェントの入力', { isSidechain: true }),
  JSON.stringify({ type: 'assistant', isSidechain: true, timestamp: at(11), message: { role: 'assistant', content: [{ type: 'tool_use', id: 's', name: 'Grep', input: { pattern: 'x' } }] } }),
  said(20, 'PR を出しました'),
  user(100, '【SAI】#o/r の「main」からのメッセージです（id: abcdef0123456789）。\n\nマージして'),
  said(110, 'マージしました'),
  user(200, '<task-notification>done</task-notification>'),
  use(205, 'Bash', { command: `echo ${'あ'.repeat(400)}` }),
]
const parsed = (lines: string[]) => {
  const p = claudeStepParser()
  for (const l of lines) p.push(l)
  return p.turns
}

test('claudeStepParser: 人の入力から次の人の入力までを 1 ターンにして、ツールの呼び出しだけを並べる（メッセージで起きたターンも）', () => {
  const turns = parsed(claude)
  assert.equal(turns.length, 3, '読み始めより前のぶんは捨てる')
  assert.deepEqual(turns[0]!.steps.map((s) => [s.tool, s.summary, s.note, s.at]), [
    ['Bash', 'pnpm test', 'テストを回す', at(5)],
    ['Edit', '/w/server/app.ts', undefined, at(7)],
    ['Task', '探す', undefined, at(9)],
  ], 'サブエージェントの中の手順は入れない。Bash の description は note に分ける')
  assert.deepEqual([turns[0]!.startedAt, turns[0]!.endedAt], [T0, T0 + 20_000])
  assert.deepEqual(turns[1]!.steps, [], 'メッセージで起きたターン（ツールなし）')
  assert.equal(Array.from(turns[2]!.steps[0]!.summary).length, TURN_STEP_TEXT_MAX, '長いコマンドは切る')
  assert.equal(JSON.stringify(turns).includes('SECRET'), false, 'ツールの出力は持たない')
})

test('手順の要約は許可のバブルと同じ文字列（toolSummary）', () => {
  const turns = parsed(claude)
  assert.equal(turns[0]!.steps[0]!.summary, toolSummary('Bash', { command: 'pnpm test', description: 'テストを回す' }))
  assert.equal(turns[0]!.steps[1]!.summary, toolSummary('Edit', { file_path: '/w/server/app.ts', old_string: 'a', new_string: 'b' }))
})

test('codexStepParser: task_started から task_complete までを 1 ターンにする', () => {
  const ev = (s: number, type: string) => JSON.stringify({ timestamp: at(s), type: 'event_msg', payload: { type } })
  const item = (s: number, payload: Record<string, unknown>) => JSON.stringify({ timestamp: at(s), type: 'response_item', payload })
  const p = codexStepParser()
  for (const l of [
    item(-5, { type: 'function_call', name: 'shell', call_id: 'c0', arguments: '{"command":["bash","-lc","前のターン"]}' }),
    ev(0, 'task_started'),
    item(2, { type: 'function_call', name: 'shell', call_id: 'c1', arguments: '{"command":["bash","-lc","pnpm lint\\npnpm test"]}' }),
    item(3, { type: 'function_call_output', call_id: 'c1', output: 'SECRET' }),
    item(4, { type: 'custom_tool_call', name: 'exec', call_id: 'c2', input: 'tools.exec_command({"cmd":"git status"})' }),
    item(8, { type: 'message', role: 'assistant', content: [{ text: '終わりました' }] }),
    ev(9, 'task_complete'),
    ev(50, 'task_started'),
  ]) p.push(l)
  assert.equal(p.turns.length, 2)
  assert.deepEqual(p.turns[0]!.steps.map((s) => [s.tool, s.summary]), [['shell', 'pnpm lint\npnpm test'], ['exec', 'git status']], '1 行に切らない')
  assert.equal(p.turns[0]!.endedAt, T0 + 9000)
  assert.equal(JSON.stringify(p.turns).includes('SECRET'), false)
})

const from = (ms: number, input?: string) => ({ starts: [{ ms, ...(input ? { input } : {}) }] })

test('findStepTurn: 入力の行の時刻で当て、無ければターン完了の行の少し前に終わったもの。近いものが無ければ null', () => {
  const turns = parsed(claude)
  assert.equal(findStepTurn(turns, { ...from(T0 + 400), endMs: T0 + 21_000 })?.steps.length, 3)
  assert.equal(findStepTurn(turns, { endMs: T0 + 112_000 }), turns[1], '入力の行が無い（メッセージ・自分で起きたターン）ときは終わりで当てる')
  assert.equal(findStepTurn(turns, { endMs: T0 + 21_000 }), turns[0])
  assert.equal(findStepTurn(turns, { ...from(T0 + 60_000), endMs: T0 + 70_000 }), null, '別のターンの手順を出さない')
  assert.equal(findStepTurn([], { endMs: T0 }), null)
})

test('skipForSteps / stepCounts', () => {
  assert.equal(skipForSteps(result(1)), true)
  assert.equal(skipForSteps(use(1, 'Bash', { command: 'ls' })), false)
  assert.equal(skipForSteps(user(1, '指示')), false)
  assert.deepEqual(parsed(claude.filter((l) => !skipForSteps(l))), parsed(claude), '落としても結果は変わらない')
  assert.equal(stepCounts([{ tool: 'Edit' }, { tool: 'Bash' }, { tool: 'Bash' }, { tool: '' }]), 'Bash 2・Edit 1・ツール 1')
})

test('findStepTurn: 途中で入力が足されたターンはつないで 1 つにする。Esc で止めたターンの手順は次のターンに混ぜない（#663 のレビュー）', () => {
  // 1 つの記録のターンの途中で入力が足された（steer・タスクの通知）: transcript では 2 つに切れる
  const steered = parsed([user(0, '実装して'), use(5, 'Bash', { command: 'pnpm test' }), user(10, 'lint も回して'), use(15, 'Bash', { command: 'pnpm lint' }), said(20, 'しました')])
  assert.equal(steered.length, 2)
  assert.deepEqual(findStepTurn(steered, { starts: [{ ms: T0, input: '実装して' }, { ms: T0 + 10_000, input: 'lint も回して' }], endMs: T0 + 21_000 })?.steps.map((s) => s.summary), ['pnpm test', 'pnpm lint'])

  // Esc で止めた入力（ターン完了の行なし）のあと、入力の行の無いターンが終わった
  const stopped = parsed([user(0, '消して'), use(5, 'Bash', { command: 'rm -rf build' }), user(8, '[Request interrupted by user]'), user(100, '<task-notification>done</task-notification>'), use(105, 'Bash', { command: 'git status' }), said(110, '確認しました')])
  assert.deepEqual(findStepTurn(stopped, { ...from(T0, '消して'), endMs: T0 + 111_000 })?.steps.map((s) => s.summary), ['git status'], '止めたターンのコマンドを、次の返答の手順として出さない')

  // Esc ですぐ止めた入力は transcript に残らないことがある: 次の入力の行で当てる
  const pulled = parsed([user(30, 'やり直し'), use(35, 'Bash', { command: 'pnpm build' }), said(40, 'しました')])
  assert.deepEqual(findStepTurn(pulled, { starts: [{ ms: T0, input: '打ちかけ' }, { ms: T0 + 30_000, input: 'やり直し' }], endMs: T0 + 41_000 })?.steps.map((s) => s.summary), ['pnpm build'])

  // ターン完了の行のあともそのターンが続いた（Stop フックが続けさせた）・行が遅れて書かれた: 始まりで当てたターンを返す
  assert.equal(findStepTurn(parsed(claude), { ...from(T0), endMs: T0 + 5_000_000 })?.steps.length, 3)
})
