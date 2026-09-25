import { test } from 'node:test'
import assert from 'node:assert/strict'
import { jevAsks, jevLabel, jevLevel, jevSafeOf, jevState, JEV_STATE_MAX } from './jev.ts'
import type { Approval } from './types.ts'

const a = (over: Partial<Approval> = {}): Approval => ({
  approval_id: 'ap1',
  id: 'S@sai',
  since: '2026-09-25T10:00:00Z',
  tool_name: 'Bash',
  input: { command: 'git status', description: '状態を見る' },
  tool_use_id: 't1',
  text: '許可待ち: Bash: git status',
  ...over,
})

test('jevAsks: SAI が答えられる許可だけ。検出専用と質問は聞かない', () => {
  assert.equal(jevAsks(a()), true)
  assert.equal(jevAsks(a({ answerable: true, agent: 'codex', tool_name: 'CodexCommand' })), true)
  assert.equal(jevAsks(a({ answerable: false, agent: 'codex', tool_name: 'CodexDialog' })), false, '検出専用（押せない）')
  assert.equal(jevAsks(a({ tool_name: 'AskUserQuestion' })), false, '質問は「問題ないか」の話ではない')
  assert.equal(jevAsks(a({ tool_name: 'ExitPlanMode' })), false)
})

test('jevState: Claude はツール名と名指しした項目（コマンド・説明）を送る。要約（text）は送らない', () => {
  const state = jevState(a())
  assert.match(state, /Tool: Bash/)
  assert.match(state, /Command: git status/)
  assert.match(state, /Description: 状態を見る/)
  assert.doesNotMatch(state, /許可待ち/, '要約は送らない')
  // 長いコマンドも全部（上限まで）
  const long = `echo ${'x'.repeat(300)}`
  assert.match(jevState(a({ input: { command: long }, text: `許可待ち: Bash: ${long.slice(0, 100)}…` })), new RegExp(`Command: ${long}`))
})

test('jevState: MCP のツールは要約が input の JSON なので、要約も input も送らない（ファイル・メッセージの本文が混ざる。#493 のレビュー）', () => {
  const input = { owner: 'me', repo: 'r', path: 'secret.ts', content: 'SECRET_FILE_BODY', message: 'SECRET_MESSAGE' }
  const state = jevState(a({ tool_name: 'mcp__github__create_or_update_file', input, text: `許可待ち: mcp__github__create_or_update_file: ${JSON.stringify(input)}` }))
  assert.match(state, /Tool: mcp__github__create_or_update_file/)
  assert.doesNotMatch(state, /SECRET_FILE_BODY|SECRET_MESSAGE/)
})

test('jevState: ファイルの中身（Write の content / Edit の old_string・new_string）と cwd は送らない', () => {
  const state = jevState(
    a({
      tool_name: 'Edit',
      input: { file_path: 'src/app.ts', old_string: 'SECRET_OLD', new_string: 'SECRET_NEW', cwd: '/Users/me/work' },
      text: '許可待ち: Edit: src/app.ts',
    }),
  )
  assert.match(state, /src\/app\.ts/)
  assert.doesNotMatch(state, /SECRET_OLD|SECRET_NEW|\/Users\/me/)
  const write = jevState(a({ tool_name: 'Write', input: { file_path: 'a.txt', content: 'SECRET_BODY' }, text: '許可待ち: Write: a.txt' }))
  assert.doesNotMatch(write, /SECRET_BODY/)
})

test('jevState: Codex の理由とダイアログの中身を送る。全体は上限で切る', () => {
  const codex = jevState(a({ agent: 'codex', tool_name: 'CodexCommand', input: { command: 'git push', reason: 'PR を出すため' }, text: '許可待ち: コマンド: git push' }))
  assert.match(codex, /\(codex\)/)
  assert.match(codex, /Reason: PR を出すため/)
  const dialog = jevState(
    a({ agent: 'codex', tool_name: 'CodexDialog', input: {}, text: 'Codex の許可待ち: git add -A', dialog: { title: 'Would you like to run the following command?', detail: 'Reason: コミットのため', command: 'git add -A', options: [] } }),
  )
  assert.match(dialog, /Dialog: Would you like/)
  assert.match(dialog, /Command: git add -A/)
  const huge = jevState(a({ input: { command: 'x'.repeat(10_000), description: 'y'.repeat(10_000), reason: 'z'.repeat(10_000) }, text: 'z' }))
  assert.ok(huge.length <= JEV_STATE_MAX + 1, `上限で切る（${huge.length}）`)
})

test('jevLevel / jevLabel: 0.8 以上は問題なさそう、0.3 未満は危なそう、間は割れる', () => {
  assert.equal(jevLevel(0.97), 'safe')
  assert.equal(jevLevel(0.8), 'safe')
  assert.equal(jevLevel(0.79), 'unsure')
  assert.equal(jevLevel(0.3), 'unsure')
  assert.equal(jevLevel(0.29), 'risky')
  assert.equal(jevLabel(0.974), '問題なさそう 97%')
  assert.equal(jevLabel(0.59), '判断が割れる 59%')
  assert.equal(jevLabel(0.01), '危なそう 1%')
})

test('jevSafeOf: noul の数だけ取る。形が違えば null（0 や 1 にしない）', () => {
  assert.equal(jevSafeOf({ answers: { safe: { type: 'noul', noul: 0.97 } } }, 'safe'), 0.97)
  assert.equal(jevSafeOf({ answers: { safe: { type: 'noul', noul: 0 } } }, 'safe'), 0)
  for (const bad of [null, {}, { answers: {} }, { answers: { safe: {} } }, { answers: { safe: { noul: '0.9' } } }, { answers: { safe: { noul: 1.5 } } }, { answers: { safe: { noul: NaN } } }]) {
    assert.equal(jevSafeOf(bad, 'safe'), null, JSON.stringify(bad))
  }
})
