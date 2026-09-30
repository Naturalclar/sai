import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EXPECTED_CLAUDE_HOOKS, claudeHookGaps, hookGapLabel } from './hooks.ts'

/** record.py に届くのは直書きか `sai-record`（ラッパー）だけ、とする */
const reaches = (cmd: string) => cmd.includes('record.py') || cmd.startsWith('sai-record')

const group = (command: string, matcher?: string) => ({ ...(matcher !== undefined ? { matcher } : {}), hooks: [{ type: 'command', command }] })

/** README の例と同じ形で、全部繋がっている設定 */
function full(command = 'python3 "$SAI_HOME/feed/record.py" || true') {
  return {
    hooks: Object.fromEntries(EXPECTED_CLAUDE_HOOKS.map((h) => [h.event, [group(command, h.matcher || undefined)]])),
  }
}

test('claudeHookGaps: 全部繋がっていれば空', () => {
  assert.deepEqual(claudeHookGaps([full()], reaches), [])
  assert.deepEqual(claudeHookGaps([full('sai-record')], reaches), [], 'ラッパー経由でも届いていれば同じ')
})

test('claudeHookGaps: 届くフックが無いイベントは missing。ほかのコマンドだけの塊は数えない', () => {
  const s = full('sai-record')
  // この Mac の実際の形: SessionEnd には別のコマンド（tmux の色替え）しか居ない
  s.hooks.SessionEnd = [group('tmux-pane-highlight off')]
  const gaps = claudeHookGaps([s], reaches)
  assert.deepEqual(gaps, [{ event: 'SessionEnd', kind: 'missing', uncovered: [] }])
  assert.deepEqual(gaps!.map(hookGapLabel), ['SessionEnd'])
})

test('claudeHookGaps: matcher が足りなければ当たっていない値を出す。複数の塊は合わせて見る', () => {
  const s = full()
  s.hooks.Notification = [group('sai-record', 'idle_prompt|permission_prompt'), group('sai-record', 'agent_needs_input')]
  const gaps = claudeHookGaps([s], reaches)!
  assert.deepEqual(gaps, [{ event: 'Notification', kind: 'matcher', uncovered: ['elicitation_dialog', 'elicitation_url_dialog'] }])
  assert.equal(hookGapLabel(gaps[0]!), 'Notification（matcher に elicitation_dialog / elicitation_url_dialog が無い）')
  // matcher 無し・* は全部に当たる
  s.hooks.Notification = [group('sai-record', '*')]
  assert.deepEqual(claudeHookGaps([s], reaches), [])
  // matcher 無しで繋ぐべきものが絞られている
  s.hooks.PermissionRequest = [group('sai-record', 'Bash')]
  assert.deepEqual(claudeHookGaps([s], reaches)!.map(hookGapLabel), ['PermissionRequest（matcher が絞られている）'])
})

test('claudeHookGaps: 届くフックが 1 つも無ければ「分からない」（null）。全部足りないとは言わない', () => {
  assert.equal(claudeHookGaps([{ hooks: { Stop: [group('some-wrapper')] } }], reaches), null)
  assert.equal(claudeHookGaps([{}], reaches), null)
  assert.equal(claudeHookGaps([], reaches), null)
  assert.equal(claudeHookGaps([{ hooks: 'broken' }, null, { hooks: { Stop: 'x' } }], reaches), null, '壊れた形は読み飛ばす')
})

test('claudeHookGaps: 設定を複数渡したら合わせて見る（ユーザーとプロジェクト）', () => {
  const user = { hooks: { Stop: [group('sai-record')] } }
  const project = full()
  delete (project.hooks as Record<string, unknown>).Stop
  assert.deepEqual(claudeHookGaps([user, project], reaches), [])
  assert.deepEqual(claudeHookGaps([user], reaches)!.map((g) => g.event), ['PermissionRequest', 'PreToolUse', 'Notification', 'UserPromptSubmit', 'SessionEnd'])
})

test('claudeHookGaps: matcher は正規表現として見る（.* や前方の一致も当たっている扱い。#569 のレビュー）', () => {
  const s = full()
  s.hooks.Notification = [group('sai-record', '.*')]
  s.hooks.PreToolUse = [group('sai-record', 'AskUser.*|ExitPlanMode')]
  s.hooks.PermissionRequest = [group('sai-record', '.*')]
  assert.deepEqual(claudeHookGaps([s], reaches), [])
  s.hooks.Notification = [group('sai-record', 'idle_.*|agent_needs_input|elicitation_.*|permission_prompt')]
  assert.deepEqual(claudeHookGaps([s], reaches), [])
  // 当たらない正規表現は今までどおり足りない値を出す
  s.hooks.Notification = [group('sai-record', 'idle_.*')]
  assert.deepEqual(claudeHookGaps([s], reaches)![0]!.uncovered, ['agent_needs_input', 'elicitation_dialog', 'elicitation_url_dialog', 'permission_prompt'])
  // 正規表現として読めなければ名前の一致に落とす（落ちない）
  s.hooks.Notification = [group('sai-record', 'idle_prompt|(broken')]
  assert.equal(claudeHookGaps([s], reaches)![0]!.kind, 'matcher')
})
