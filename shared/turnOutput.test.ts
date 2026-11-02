// 手順の出力・差分（#846）。行の形は作り物
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { TURN_OUTPUT_HEAD, TURN_OUTPUT_TAIL, claudeOutputFinder, clipOutput, codexOutputFinder, diffLineKind, isOutputRef, plainOutput } from './turnOutput.ts'
import type { OutputFinder } from './turnOutput.ts'

const run = (finder: OutputFinder, lines: string[]) => {
  const fed: string[] = []
  for (const line of lines) {
    if (finder.skip(line)) continue
    fed.push(line)
    if (finder.push(line)) break
  }
  return { sections: finder.sections(), fed }
}
const j = (v: unknown) => JSON.stringify(v)
const result = (id: string, toolUseResult: unknown, content: unknown = 'モデルに渡した文', extra: object = {}) => j({ type: 'user', toolUseResult, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content, ...extra }] } })
const item = (type: 'custom_tool_call' | 'function_call', call_id: string, name: string, extra: object = {}) => j({ type: 'response_item', payload: { type, call_id, name, ...extra } })
const output = (call_id: string, value: unknown, type = 'custom_tool_call_output') => j({ type: 'response_item', payload: { type, call_id, output: value } })
const done = (it: object) => j({ type: 'event_msg', payload: { type: 'item_completed', item: it } })
const command = (cmd: string, out: string, exit_code = 0) => done({ type: 'CommandExecution', id: 'item', command: ['/bin/sh', '-lc', cmd], aggregated_output: out, exit_code })

test('Claude: Bash は stdout と stderr。ほかの呼び出しの戻りは読まず、見つけたら止まる', () => {
  const lines = [result('other', { stdout: '別のコマンド' }), result('t1', { stdout: '出力', stderr: '警告' }), result('t1', { stdout: '読まれない' })]
  const { sections, fed } = run(claudeOutputFinder('t1'), lines)
  assert.deepEqual(sections.map((s) => [s.label, s.kind, s.text]), [['stdout', 'output', '出力'], ['stderr', 'output', '警告']])
  assert.equal(fed.length, 1, '`ref` の無い行は JSON にせず、見つけたあとは読まない')
})

test('Claude: 失敗は toolUseResult が文字列なので、戻りの文を「失敗」で出す', () => {
  const { sections } = run(claudeOutputFinder('t1'), [result('t1', 'Error: Exit code 1', [{ type: 'text', text: 'Exit code 1\nだめ' }], { is_error: true })])
  assert.deepEqual(sections, [{ label: '出力', kind: 'output', text: 'Exit code 1\nだめ', failed: true }])
})

test('Claude: Edit は structuredPatch を差分に、originalFile は出さない。新しいファイルの Write は全部 +', () => {
  const patch = { filePath: '/w/a.ts', originalFile: 'ファイル全体', structuredPatch: [{ oldStart: 3, oldLines: 2, newStart: 3, newLines: 2, lines: [' 前', '-古い', '+新しい'] }] }
  const [edit] = run(claudeOutputFinder('t1'), [result('t1', patch)]).sections
  assert.deepEqual(edit, { label: '/w/a.ts', kind: 'diff', text: '@@ -3,2 +3,2 @@\n 前\n-古い\n+新しい' })
  const [write] = run(claudeOutputFinder('t2'), [result('t2', { type: 'create', filePath: '/w/b.ts', content: '一\n二\n', structuredPatch: [] })]).sections
  assert.equal(write?.text, '+一\n+二')
})

test('秘密に見えるパスの編集は中身を出さない（Claude の差分・Codex の変更とも）', () => {
  const claude = run(claudeOutputFinder('t1'), [result('t1', { filePath: '/w/.env', content: 'KEY=作り物', structuredPatch: [] })]).sections
  assert.deepEqual(claude, [{ label: '/w/.env', kind: 'diff', text: '', withheld: true }])
  const lines = [item('custom_tool_call', 'c1', 'exec'), done({ type: 'FileChange', changes: { '/w/.env': { type: 'add', content: 'KEY=作り物' }, '/w/a.ts': { type: 'update', unified_diff: '@@ -1 +1 @@\n-a\n+b' } } })]
  assert.deepEqual(run(codexOutputFinder('c1'), lines).sections, [
    { label: '/w/.env', kind: 'diff', text: '', withheld: true },
    { label: '/w/a.ts', kind: 'diff', text: '@@ -1 +1 @@\n-a\n+b' },
  ])
  const patch = '*** Begin Patch\n*** Add File: config/.env\n+KEY=作り物\n*** End Patch'
  assert.deepEqual(run(codexOutputFinder('c1'), [item('custom_tool_call', 'c1', 'apply_patch', { input: patch })]).sections, [{ label: 'パッチ', kind: 'diff', text: '', withheld: true }])
})

test('Codex: exec の項目を集める。項目の id は call_id と別で、次の呼び出しで止まる', () => {
  const lines = [
    item('custom_tool_call', 'c0', 'exec'), command('前のコマンド', '混ざらない'), output('c0', [{ type: 'input_text', text: 'x' }]),
    item('custom_tool_call', 'c1', 'exec'), command('pnpm  test', '通った'), command('false', 'だめ', 2), output('c1', [{ type: 'input_text', text: 'モデルに渡した文' }]),
    command('戻りのあとに書かれた項目', '含める'),
    item('custom_tool_call', 'c2', 'exec'), command('次のコマンド', '混ざらない'),
  ]
  assert.deepEqual(run(codexOutputFinder('c1'), lines).sections, [
    { label: 'pnpm test', kind: 'output', text: '通った' },
    { label: 'false', kind: 'output', text: 'だめ', exit_code: 2, failed: true },
    { label: '戻りのあとに書かれた項目', kind: 'output', text: '含める' },
  ])
})

test('Codex: 同時に投げた呼び出しは自分の戻りまで閉じない。ターンの切れ目で止まる', () => {
  const lines = [item('custom_tool_call', 'c1', 'exec'), item('custom_tool_call', 'c2', 'exec'), command('b', '二つ目の分'), output('c2', 'x'), command('a', '一つ目の分'), output('c1', 'y'), j({ type: 'event_msg', payload: { type: 'task_complete' } }), command('次のターン', '混ざらない')]
  assert.deepEqual(run(codexOutputFinder('c1'), lines).sections.map((s) => s.label), ['b', 'a'])
})

test('Codex: 項目を書かない版は戻りの文を出す（JSON の包みは外す）。apply_patch は本文をパッチとして出す', () => {
  assert.equal(run(codexOutputFinder('c1'), [item('function_call', 'c1', 'shell'), output('c1', j({ output: '中身', metadata: {} }), 'function_call_output')]).sections[0]?.text, '中身')
  assert.equal(run(codexOutputFinder('c1'), [item('custom_tool_call', 'c1', 'exec'), output('c1', [{ type: 'input_text', text: 'ログ' }])]).sections[0]?.text, 'ログ')
  const patch = '*** Begin Patch\n*** Update File: a.ts\n@@\n-a\n+b\n*** End Patch'
  assert.deepEqual(run(codexOutputFinder('c1'), [item('custom_tool_call', 'c1', 'apply_patch', { input: patch }), output('c1', 'ok')]).sections, [{ label: 'パッチ', kind: 'diff', text: patch }])
})

test('長い本文は頭と末尾だけ。末尾を厚く残し、切り口は行の境目に寄せる', () => {
  const line = '0123456789'.repeat(9)
  const text = Array.from({ length: 2000 }, (_, i) => `${i}:${line}`).join('\n')
  const got = clipOutput(text)
  assert.ok(got.text.length <= TURN_OUTPUT_HEAD && (got.tail?.length ?? 0) <= TURN_OUTPUT_TAIL)
  assert.match(got.tail ?? '', /^\d+:0123/, '末尾は行の頭から')
  assert.match(got.text, /0123456789\n$/, '頭は行の終わりまで')
  assert.equal(got.text.length + (got.omitted ?? 0) + (got.tail?.length ?? 0), text.length)
  assert.deepEqual(clipOutput('短い'), { text: '短い' })
  const oneLine = clipOutput('あ'.repeat(TURN_OUTPUT_HEAD + TURN_OUTPUT_TAIL + 10))
  assert.equal([oneLine.text.length, oneLine.tail?.length, oneLine.omitted].join(), [TURN_OUTPUT_HEAD, TURN_OUTPUT_TAIL, 10].join(), '改行の無い長い 1 行は字数で切る')
})

test('色の制御列と CR を落とす。ref の形を見る。差分の行の種類', () => {
  assert.equal(plainOutput('\u001b[31m赤\u001b[0m\r\n\u001b]0;題\u0007次\r'), '赤\n次\n')
  assert.deepEqual(['toolu_01Ab-c', 'call_x.y:1'].map(isOutputRef), [true, true])
  assert.deepEqual(['', '../x', 'a b', 'a/b', 'x'.repeat(201)].map(isOutputRef), [false, false, false, false, false])
  assert.deepEqual(['+a', '-a', ' a', '@@ -1 +1 @@', '+++ b/a', '--- a/a', '*** Begin Patch'].map(diffLineKind), ['add', 'del', 'ctx', 'head', 'head', 'head', 'head'])
})
