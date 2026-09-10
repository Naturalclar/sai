import { test } from 'node:test'
import assert from 'node:assert/strict'
import { CLEAR_RECAPTURES, isDescendant, MAX_CLEAR_KEYS, parsePs, promptState, TerminalBusy, TerminalGone, TerminalReplies, typeInto, TERMINAL_REPLY_TTL_MS } from './terminal.ts'
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

test('promptState: Codex の質問選択・自由入力待ちもダイアログ', () => {
  assert.equal(promptState('質問\n› 1. A\n  2. B\nEnter to select · Esc to cancel', 'codex').kind, 'dialog')
  assert.equal(promptState('Waiting for user input\n› Type your answer', 'codex').kind, 'dialog')
  assert.equal(promptState('確認\n› answer\nEnter to submit · Esc to cancel', 'codex').kind, 'dialog')
})

// OpenCode（1.18.30 の実機の capture-pane を写したもの）。箱の各行が `┃` で、下に枠線。
// 右側には作業ディレクトリのパスが同じ行に描かれ、箱の最後の行はモードとモデル
const OPENCODE_IDLE = [
  '                                    ▣  Build · Qwen3 8B · 55.7s',
  '',
  '  ┃                                                     /private/tmp/work',
  '  ┃  Ask anything… "Fix broken tests"                    naturalclar-mac-mini/',
  '  ┃',
  '  ┃  Build · Qwen3 8B Ollama                             work:main',
  '  ╹▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀',
  '  /private/tmp/work',
].join('\n')
/** placeholder の行を差し替える（打ちかけを入れる / 空にする） */
const opencodeWith = (line: string) => OPENCODE_IDLE.replace('  ┃  Ask anything… "Fix broken tests"                    naturalclar-mac-mini/', line)

test('promptState: OpenCode は枠線の上の ┃ の連なりが入力欄。placeholder もターン後の空も idle', () => {
  assert.deepEqual(promptState(OPENCODE_IDLE, 'opencode'), { idle: true, kind: 'idle', reason: '', typed: '' })
  // 1 ターン回した後は placeholder が出ず、箱が空になる（実測）。右側のパスだけが残る
  assert.equal(promptState(opencodeWith('  ┃                                                    naturalclar-mac-mini/'), 'opencode').idle, true)
  const typing = promptState(opencodeWith('  ┃  まだ送っていない文                                 naturalclar-mac-mini/'), 'opencode')
  assert.equal(typing.kind, 'typed')
  assert.equal(typing.typed, 'まだ送っていない文', '右側の列（パス）は打ちかけに混ぜない')
  // 複数行の打ちかけも `┃` で並ぶ
  const multi = promptState(opencodeWith('  ┃  1行目\n  ┃  2行目'), 'opencode')
  assert.equal(multi.typed, '1行目\n2行目')
})

test('promptState: OpenCode は会話の履歴も ┃ を使うので、枠線が無ければ打ち込まない', () => {
  // 履歴だけが見えていて入力欄の枠線が流れて消えた画面
  const history = ['  ┃  前のターンの返事', '  ┃  その続き', ''].join('\n')
  assert.equal(promptState(history, 'opencode').kind, 'unknown')
  // 枠線はあるが、その上が `┃` でない（別のプログラム）
  assert.equal(promptState('$ ls\nfoo\n  ╹▀▀▀▀▀▀▀▀▀▀', 'opencode').kind, 'unknown')
  // モード・モデルの行が読めない形に変わったら落とさず、空の入力欄でも打ちかけ側（打ち込まない）に倒れる
  const noStatus = opencodeWith('  ┃').replace('  ┃  Build · Qwen3 8B Ollama                             work:main', '  ┃  Build')
  assert.equal(promptState(noStatus, 'opencode').kind, 'typed')
})

test('promptState: kind と typed。番号付きの選択肢や「Press enter to continue」はダイアログ', () => {
  assert.deepEqual(promptState(CLAUDE_IDLE, 'claude'), { idle: true, kind: 'idle', reason: '', typed: '' })
  const typing = promptState(CLAUDE_IDLE.replace('❯ Try "refactor <filepath>"', '❯ 提案されているsub issueを立てて'), 'claude')
  assert.equal(typing.kind, 'typed')
  assert.equal(typing.typed, '提案されているsub issueを立てて', 'typed は切らない（reason は 40 文字）')
  assert.equal(promptState(CLAUDE_IDLE + '\n  ❯ 1. Yes\n    2. No\n  Enter to confirm · Esc to cancel', 'claude').kind, 'dialog')
  // Codex の信頼確認。› の後ろが「1. Yes, continue」なので打ちかけに見えるが、ダイアログ
  const trust = '> You are in /x\n  Do you trust the contents of this directory?\n› 1. Yes, continue\n  2. No, quit\n  Press enter to continue'
  assert.equal(promptState(trust, 'codex').kind, 'dialog')
  assert.equal(promptState('some output\n› 1. first option\n  2. second', 'codex').kind, 'dialog', '番号付きの選択肢だけでもダイアログ')
  assert.equal(promptState('$ ls\nfoo\n$ ', 'claude').kind, 'unknown')
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
  /** C-u を受けたらこの画面に変わる（null なら変わらない = 消せない端末） */
  afterClear: string | null = CLAUDE_IDLE
  /** C-u 1 回ごとにこの順で画面が変わる（複数行の打ちかけ）。空なら afterClear */
  clearSteps: string[] = []
  panePid: string | null = '100'
  /** Escape を受けたらこの画面に変わる（候補メニューが閉じる）。null なら変わらない */
  afterEscape: string | null = null
  /** キーを送ったあと、この回数だけ capture-pane が古い画面を返す（描き直しの遅れ） */
  lag = 0
  private pendingScreen: string | null = null
  private lagLeft = 0
  async run(args: string[], input?: string): Promise<string> {
    this.calls.push({ args, input })
    if (args[0] === 'display-message') {
      if (this.panePid === null) throw new Error("can't find pane %9")
      return this.panePid + '\n'
    }
    if (args[0] === 'capture-pane') {
      if (this.pendingScreen !== null) {
        if (this.lagLeft > 0) {
          this.lagLeft--
          return this.screen
        }
        this.screen = this.pendingScreen
        this.pendingScreen = null
      }
      return this.screen
    }
    if (args[0] === 'send-keys' && args.includes('Escape') && this.afterEscape !== null) this.screen = this.afterEscape
    if (args[0] === 'send-keys' && args.includes('C-u')) {
      const next = this.clearSteps.length > 0 ? this.clearSteps.shift()! : this.afterClear
      if (next !== null) {
        if (this.lag > 0) {
          this.pendingScreen = next
          this.lagLeft = this.lag
        } else this.screen = next
      }
    }
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

test('typeInto: replaceTyped なら打ちかけを C-u で消し、空になったのを見てから貼る。消えなければ貼らない', async () => {
  const typedScreen = CLAUDE_IDLE.replace('❯ Try "refactor <filepath>"', '❯ 打ちかけの文')
  const tmux = new FakeTmux()
  tmux.screen = typedScreen
  const result = await typeInto(tmux, ps, { pane: '%9', pid: 200 }, 'claude', '本文', { replaceTyped: true, settleMs: 0 })
  assert.equal(result.cleared, '打ちかけの文', '消した文を返す（reply.log に残す）')
  assert.deepEqual(
    tmux.calls.map((c) => (c.args[0] === 'send-keys' ? `send-keys ${c.args[3]}` : c.args[0])),
    ['display-message', 'capture-pane', 'send-keys C-u', 'capture-pane', 'load-buffer', 'paste-buffer', 'send-keys Enter'],
    'C-u（+ BSpace）→ もう一度 capture → 貼る',
  )

  // replaceTyped が無ければ今までどおり TerminalBusy（kind: typed、typed に文）
  const plain = new FakeTmux()
  plain.screen = typedScreen
  const err = await typeInto(plain, ps, { pane: '%9', pid: 200 }, 'claude', '本文').catch((e: unknown) => e)
  assert.ok(err instanceof TerminalBusy)
  assert.equal(err.kind, 'typed')
  assert.equal(err.typed, '打ちかけの文')
  assert.equal(plain.calls.some((c) => c.args.includes('C-u')), false, '確認なしでは消さない')

  // C-u が効かない端末（画面が変わらない）なら貼らない
  const stuck = new FakeTmux()
  stuck.screen = typedScreen
  stuck.afterClear = null
  const e2 = await typeInto(stuck, ps, { pane: '%9', pid: 200 }, 'claude', '本文', { replaceTyped: true, settleMs: 0 }).catch((e: unknown) => e)
  assert.ok(e2 instanceof TerminalBusy)
  assert.equal(stuck.calls.some((c) => c.args[0] === 'paste-buffer'), false)

  // ダイアログ中は replaceTyped でも消さない
  const dialog = new FakeTmux()
  dialog.screen = CLAUDE_IDLE + '\n  ❯ 1. Yes\n    2. No\n  Enter to confirm · Esc to cancel'
  const e3 = await typeInto(dialog, ps, { pane: '%9', pid: 200 }, 'claude', '本文', { replaceTyped: true, settleMs: 0 }).catch((e: unknown) => e)
  assert.ok(e3 instanceof TerminalBusy)
  assert.equal(e3.kind, 'dialog')
  assert.equal(dialog.calls.some((c) => c.args.includes('C-u') || c.args[0] === 'paste-buffer'), false)
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

test('TerminalReplies: via: terminal を付ける（要対応が別プロセスの返信と区別する。#232）', () => {
  const r = new TerminalReplies(() => Date.parse('2026-09-06T01:00:00Z'))
  assert.equal(r.start('S@r', 'やって').via, 'terminal')
  assert.equal(r.snapshot()['S@r']?.via, 'terminal', 'スナップショットにも載る（画面はこれを見る）')
})

const CODEX_IDLE = [
  '• You have 3 usage limit resets available. Run /usage to use one.',
  '› Ask Codex to do anything',
  '  gpt-5.6-sol medium · /Users/me/repo',
].join('\n')

test('promptState: Codex の placeholder「Ask Codex to do anything」は空扱い、打ちかけは typed、モデルの行は続きに含めない（#133）', () => {
  assert.deepEqual(promptState(CODEX_IDLE, 'codex'), { idle: true, kind: 'idle', reason: '', typed: '' })
  const typing = promptState(CODEX_IDLE.replace('› Ask Codex to do anything', '› これは打ちかけ'), 'codex')
  assert.equal(typing.kind, 'typed')
  assert.equal(typing.typed, 'これは打ちかけ', 'モデルの行（  gpt-5.6-sol medium · …）は打ちかけの続きではない')
  const multi = promptState(CODEX_IDLE.replace('› Ask Codex to do anything', '› a1\n  b2\n  c3'), 'codex')
  assert.equal(multi.typed, 'a1\nb2\nc3')
})

test('promptState: Claude の複数行の打ちかけは続きの行（2 文字下げ）も typed に入る（#128）', () => {
  const multi = promptState(CLAUDE_IDLE.replace('❯ Try "refactor <filepath>"', '❯\u00a01行目\n  2行目\n  3行目'), 'claude')
  assert.equal(multi.kind, 'typed')
  assert.equal(multi.typed, '1行目\n2行目\n3行目')
  assert.match(multi.reason, /1行目/)
})

test('typeInto: 複数行の打ちかけは空になるまで C-u を繰り返してから貼る。消えなくなったら止めて貼らない（#128）', async () => {
  const line = (rest: string) => CLAUDE_IDLE.replace('❯ Try "refactor <filepath>"', rest)
  const tmux = new FakeTmux()
  tmux.screen = line('❯ 1行目\n  2行目\n  3行目')
  tmux.clearSteps = [line('❯ 1行目\n  2行目'), line('❯ 1行目'), CLAUDE_IDLE]
  const result = await typeInto(tmux, ps, { pane: '%9', pid: 200 }, 'claude', '本文', { replaceTyped: true, settleMs: 0 })
  assert.equal(result.cleared, '1行目\n2行目\n3行目', '消した全文（reply.log に残す）')
  assert.equal(tmux.calls.filter((c) => c.args.includes('C-u')).length, 3, '行数ぶん C-u')
  assert.equal(tmux.calls.some((c) => c.args[0] === 'paste-buffer'), true)

  // 2 回目で画面が変わらなくなったら、それ以上送らずに 409
  const stuck = new FakeTmux()
  stuck.screen = line('❯ 1行目\n  2行目\n  3行目')
  stuck.clearSteps = [line('❯ 1行目\n  2行目')]
  stuck.afterClear = null
  const err = await typeInto(stuck, ps, { pane: '%9', pid: 200 }, 'claude', '本文', { replaceTyped: true, settleMs: 0 }).catch((e: unknown) => e)
  assert.ok(err instanceof TerminalBusy)
  assert.equal(err.typed, '1行目\n2行目', '残っている分')
  assert.equal(stuck.calls.filter((c) => c.args.includes('C-u')).length, 2, '変わらなくなった時点で止める')
  assert.ok(MAX_CLEAR_KEYS >= 20)
})

/** `/issue-tri` と打ってスラッシュコマンドの候補メニューが開いた画面。選択行にも ❯ が付く（#157） */
const CLAUDE_MENU = [
  '──────────────────────────────────────',
  '❯ /issue-tri',
  '──────────────────────────────────────',
  '❯ /issue-triage          List the open GitHub issues and order them',
  '  /issue-write           Create or update an issue',
  '  ⏵⏵ auto mode on (shift+tab to cycle)',
].join('\n')

test('promptState: 入力欄は区切り線の直上の ❯。候補メニューの選択行（❯ /issue-triage 説明）を打ちかけと読まない（#157）', () => {
  const st = promptState(CLAUDE_MENU, 'claude')
  assert.equal(st.kind, 'typed')
  assert.equal(st.typed, '/issue-tri', 'メニューの行ではなく入力欄の文')
  assert.equal(st.menu, true)
  // メニューが無ければ menu は付かない。区切り線が無い画面は今までどおり一番下の ❯
  assert.equal(promptState(CLAUDE_IDLE.replace('❯ Try "refactor <filepath>"', '❯ /clear'), 'claude').menu, undefined)
  assert.equal(promptState('some output\n❯ 打ちかけ', 'claude').typed, '打ちかけ')
  // メニューが開いていても入力欄が空（`/` だけ消した直後など）なら idle
  assert.equal(promptState(CLAUDE_MENU.replace('❯ /issue-tri', '❯ '), 'claude').idle, true)
})

test('typeInto: 候補メニューが開いていれば Escape で閉じてから C-u。描き直しが遅れても見直して貼る（#157）', async () => {
  const tmux = new FakeTmux()
  tmux.screen = CLAUDE_MENU
  tmux.afterEscape = CLAUDE_IDLE.replace('❯ Try "refactor <filepath>"', '❯ /issue-tri')
  tmux.afterClear = CLAUDE_IDLE
  const result = await typeInto(tmux, ps, { pane: '%9', pid: 200 }, 'claude', '本文', { replaceTyped: true, settleMs: 0 })
  assert.equal(result.cleared, '/issue-tri')
  const keys = tmux.calls.filter((c) => c.args[0] === 'send-keys').map((c) => c.args[3])
  assert.deepEqual(keys, ['Escape', 'C-u', 'Enter'], 'Escape → C-u → 貼って Enter')

  // C-u のあと 2 回は古い画面が返る（描き直しの遅れ）。見直して空を確かめてから貼る
  const slow = new FakeTmux()
  slow.screen = CLAUDE_IDLE.replace('❯ Try "refactor <filepath>"', '❯ 打ちかけ')
  slow.lag = 2
  const r2 = await typeInto(slow, ps, { pane: '%9', pid: 200 }, 'claude', '本文', { replaceTyped: true, settleMs: 0 })
  assert.equal(r2.cleared, '打ちかけ')
  assert.equal(slow.calls.filter((c) => c.args.includes('C-u')).length, 1, '見直しの間は C-u を重ねない')
  assert.ok(slow.calls.some((c) => c.args[0] === 'paste-buffer'))
  assert.ok(CLEAR_RECAPTURES >= 2)
})
