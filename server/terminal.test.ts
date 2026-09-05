import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isDescendant, parsePs, promptState, TerminalBusy, TerminalGone, TerminalReplies, typeInto, TERMINAL_REPLY_TTL_MS } from './terminal.ts'
import type { Tmux } from './terminal.ts'

const CLAUDE_IDLE = [
  '▎ Channels (experimental) messages from server:sai',
  '──────────────────────────────────────',
  '❯ Try "refactor <filepath>"',
  '──────────────────────────────────────',
  '  ⏵⏵ auto mode on (shift+tab to cycle)',
].join('\n')

test('promptState: Claude の空の入力欄（placeholder）は idle、打ちかけは busy、ダイアログは busy', () => {
  assert.equal(promptState(CLAUDE_IDLE, 'claude').idle, true)
  assert.equal(promptState(CLAUDE_IDLE.replace('❯ Try "refactor <filepath>"', '❯ '), 'claude').idle, true)
  // 実機の capture-pane は ❯ の後ろが NBSP
  assert.equal(promptState(CLAUDE_IDLE.replace('❯ Try "refactor <filepath>"', '❯\u00a0Try "how do I log an error?"'), 'claude').idle, true)
  assert.equal(promptState(CLAUDE_IDLE.replace('❯ Try "refactor <filepath>"', '❯\u00a0打ちかけ'), 'claude').idle, false)
  // 初回に出る auto mode の案内もダイアログ
  const autoMode = CLAUDE_IDLE + '\n  Teach auto mode about your environment?\n  ❯ 1. Yes\n    2. Not now\n  Enter to confirm · Esc to cancel'
  assert.match(promptState(autoMode, 'claude').reason, /ダイアログ/)
  const typing = promptState(CLAUDE_IDLE.replace('❯ Try "refactor <filepath>"', '❯ まだ送っていない文'), 'claude')
  assert.equal(typing.idle, false)
  assert.match(typing.reason, /打ちかけ/)
  const dialog = promptState(CLAUDE_IDLE + '\n  ❯ 1. Yes\n    2. No\n  Enter to confirm · Esc to cancel', 'claude')
  assert.equal(dialog.idle, false)
  assert.match(dialog.reason, /ダイアログ/)
  // 実機は入力欄の下に空行が何十行も続く
  assert.equal(promptState(CLAUDE_IDLE + '\n'.repeat(40), 'claude').idle, true)
  const none = promptState('$ ls\nfoo bar\n$ ', 'claude')
  assert.equal(none.idle, false, '入力欄が見つからなければ打ち込まない')
})

test('promptState: Codex は › か > が入力欄', () => {
  assert.equal(promptState('some output\n› ', 'codex').idle, true)
  assert.equal(promptState('some output\n› typing', 'codex').idle, false)
})

test('parsePs / isDescendant', () => {
  const parents = parsePs('  1     0\n 100     1\n 200   100\n 300   200\n')
  assert.equal(isDescendant(300, 100, parents), true)
  assert.equal(isDescendant(100, 100, parents), true)
  assert.equal(isDescendant(100, 300, parents), false)
  assert.equal(isDescendant(999, 1, parents), false, '知らない pid')
})

class FakeTmux implements Tmux {
  calls: { args: string[]; input?: string }[] = []
  screen = CLAUDE_IDLE
  panePid: string | null = '100'
  async run(args: string[], input?: string): Promise<string> {
    this.calls.push({ args, input })
    if (args[0] === 'display-message') {
      if (this.panePid === null) throw new Error("can't find pane %9")
      return this.panePid + '\n'
    }
    if (args[0] === 'capture-pane') return this.screen
    return ''
  }
}
const ps = async () => ' 100     1\n 200   100\n'

test('typeInto: ペインの子孫で入力欄が空なら load-buffer → paste-buffer -p → Enter', async () => {
  const tmux = new FakeTmux()
  await typeInto(tmux, ps, { pane: '%9', pid: 200 }, 'claude', '続きを\nやって')
  const ops = tmux.calls.map((c) => c.args[0])
  assert.deepEqual(ops, ['display-message', 'capture-pane', 'load-buffer', 'paste-buffer', 'send-keys'])
  assert.equal(tmux.calls[2]!.input, '続きを\nやって', '本文は引数ではなく stdin で渡す')
  assert.ok(tmux.calls[3]!.args.includes('-p'), 'bracketed paste')
  assert.deepEqual(tmux.calls[4]!.args, ['send-keys', '-t', '%9', 'Enter'])
})

test('typeInto: ペインが無い・別のプロセスなら TerminalGone、入力中なら TerminalBusy（何も打たない）', async () => {
  const gone = new FakeTmux()
  gone.panePid = null
  await assert.rejects(typeInto(gone, ps, { pane: '%9', pid: 200 }, 'claude', 'x'), TerminalGone)
  const other = new FakeTmux()
  await assert.rejects(typeInto(other, ps, { pane: '%9', pid: 999 }, 'claude', 'x'), TerminalGone)
  const busy = new FakeTmux()
  busy.screen = CLAUDE_IDLE.replace('❯ Try "refactor <filepath>"', '❯ 打ちかけ')
  await assert.rejects(typeInto(busy, ps, { pane: '%9', pid: 200 }, 'claude', 'x'), TerminalBusy)
  assert.equal(busy.calls.some((c) => c.args[0] === 'paste-buffer' || c.args[0] === 'send-keys'), false)
})

test('TerminalReplies: ターン完了の行が since より新しくなったら消える。TTL でも消える', () => {
  let now = Date.parse('2026-09-06T01:00:00Z')
  const r = new TerminalReplies(() => now)
  r.start('S@r', 'やって')
  assert.equal(r.running('S@r'), true)
  r.settle(() => '2026-09-06T00:59:00Z')
  assert.equal(r.running('S@r'), true, '古いターンでは消えない')
  r.settle(() => '2026-09-06T01:00:05Z')
  assert.equal(r.running('S@r'), false)
  r.start('T@r', 'x')
  now += TERMINAL_REPLY_TTL_MS + 1
  r.settle(() => undefined)
  assert.equal(r.running('T@r'), false)
})
