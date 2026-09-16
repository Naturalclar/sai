import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { SessionSummary } from '../../shared/types.ts'
import { approvalMapKey, CodexDialogs, mergeApprovalMaps } from './codexDialogs.ts'
import type { Tmux } from './terminal.ts'

class FakeTmux implements Tmux {
  screen = '› 1. Yes\n  2. No\nEnter to confirm · Esc to cancel'
  panePid = '100\n'
  async run(args: string[]): Promise<string> {
    if (args[0] === 'display-message') return this.panePid
    if (args[0] === 'capture-pane') return this.screen
    throw new Error(`unexpected tmux call: ${args.join(' ')}`)
  }
}

const session = (agent: 'codex' | 'claude' = 'codex') =>
  ({ id: 'T1@repo', agent, terminal: { pane: '%9', pid: 200 } }) as SessionSummary

test('CodexDialogs: 同じpidのCodexペインがダイアログ中なら検出専用Approvalを出し、消えたら片付ける', async () => {
  const tmux = new FakeTmux()
  let now = Date.parse('2026-09-09T12:00:00+09:00')
  const dialogs = new CodexDialogs(tmux, async () => '200 100\n100 1\n', () => now)

  const waiting = await dialogs.scan([session()])
  assert.equal(waiting['T1@repo']?.[0]?.text, 'Codex の画面で質問または許可への回答を待っている')
  assert.equal(waiting['T1@repo']?.[0]?.agent, 'codex')
  assert.equal(waiting['T1@repo']?.[0]?.answerable, false)
  assert.equal(waiting['T1@repo']?.[0]?.since, '2026-09-09T03:00:00.000Z')

  now += 10_000
  assert.equal((await dialogs.scan([session()]))['T1@repo']?.[0]?.since, '2026-09-09T03:00:00.000Z', '待機中は開始時刻を保つ')
  tmux.screen = 'done\n› Ask Codex to do anything\n  gpt-5.6-sol medium · /work'
  assert.deepEqual(await dialogs.scan([session()]), {})
})

test('CodexDialogs: pid不一致・Claude・ペイン消滅は待機と断定しない', async () => {
  const tmux = new FakeTmux()
  const mismatch = new CodexDialogs(tmux, async () => '999 100\n100 1\n')
  assert.deepEqual(await mismatch.scan([session()]), {})
  assert.deepEqual(await mismatch.scan([session('claude')]), {})
  tmux.panePid = ''
  assert.deepEqual(await mismatch.scan([session()]), {})
})

test('mergeApprovalMaps / approvalMapKey: ClaudeとCodexを時刻順に重ね、順序に依らない鍵を作る', () => {
  const codex = { approval_id: 'x', id: 'T@r', since: '2026-09-09T02:00:00Z', tool_name: 'CodexDialog', input: {}, tool_use_id: '', text: 'codex' }
  const claude = { approval_id: 'c', id: 'T@r', since: '2026-09-09T01:00:00Z', tool_name: 'Bash', input: {}, tool_use_id: '', text: 'claude' }
  const merged = mergeApprovalMaps({ 'T@r': [codex] }, { 'T@r': [claude] })
  assert.deepEqual(merged['T@r']?.map((a) => a.approval_id), ['c', 'x'])
  assert.equal(approvalMapKey(merged), 'c,x')
  assert.equal(approvalMapKey({ 'T@r': [codex, claude] }), 'c,x')
})

/** 実機の形（codex 0.154.0）。会話の行は字下げが無く、ダイアログは 2 文字下げ */
const askScreen = (command: string) =>
  [
    '⚠ MCP startup incomplete (failed: linear)',
    '',
    '  Would you like to run the following command?',
    '',
    `  $ ${command}`,
    '',
    '› 1. Yes, proceed (y)',
    '  2. No, and tell Codex what to do differently (esc)',
    '',
    '  Press enter to confirm or esc to cancel',
  ].join('\n')

test('CodexDialogs: 画面から読んだ選択肢を Approval に載せる（#425）', async () => {
  const tmux = new FakeTmux()
  tmux.screen = askScreen('git add -A')
  const dialogs = new CodexDialogs(tmux, async () => '200 100\n100 1\n', () => Date.parse('2026-09-16T12:00:00+09:00'))

  const approval = (await dialogs.scan([session()]))['T1@repo']?.[0]
  assert.equal(approval?.text, 'Codex の許可待ち: git add -A', '一覧の 1 行も中身にする')
  assert.equal(approval?.answerable, false, '答えるのは端末のまま')
  assert.equal(approval?.dialog?.title, 'Would you like to run the following command?')
  assert.equal(approval?.dialog?.command, 'git add -A')
  assert.deepEqual(approval?.dialog?.options.map((o) => `${o.number}${o.selected ? '*' : ''}`), ['1*', '2'])
})

test('CodexDialogs: 次の許可に変わったら別の待ちにする（鍵が変わらないと画面が拾えない）', async () => {
  const tmux = new FakeTmux()
  tmux.screen = askScreen('git add -A')
  let now = Date.parse('2026-09-16T12:00:00+09:00')
  const dialogs = new CodexDialogs(tmux, async () => '200 100\n100 1\n', () => now)
  const first = (await dialogs.scan([session()]))['T1@repo']?.[0]

  now += 10_000
  tmux.screen = tmux.screen.replace('› 1.', '  1.').replace('  2.', '› 2.')
  const moved = (await dialogs.scan([session()]))['T1@repo']?.[0]
  assert.equal(moved?.approval_id, first?.approval_id, 'カーソルが動いただけなら同じ待ち')
  assert.equal(moved?.since, first?.since, '待ち始めた時刻も戻さない')

  now += 10_000
  tmux.screen = askScreen('git commit -m wip')
  const next = (await dialogs.scan([session()]))['T1@repo']?.[0]
  assert.notEqual(next?.approval_id, first?.approval_id, '中身が変われば別の approval_id')
  assert.equal(next?.since, '2026-09-16T03:00:20.000Z', '新しく待ち始めた時刻')
  assert.equal(next?.dialog?.command, 'git commit -m wip')
})
