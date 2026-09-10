import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { SessionSummary } from '../shared/types.ts'
import type { Tmux } from './terminal.ts'
import { clearSettled, NoWaitingSettle, settledKey, WaitingSettle } from './waitingSettle.ts'

/** Claude の入力欄。placeholder だけなら idle */
const CLAUDE_IDLE = ['──────', '❯ Try "refactor <filepath>"', '──────'].join('\n')
const CLAUDE_DIALOG = `${CLAUDE_IDLE}\n  ❯ 1. Yes\n    2. No\n  Enter to confirm · Esc to cancel`
const CLAUDE_TYPED = ['──────', '❯ 打ちかけ', '──────'].join('\n')
/** 入力欄が見つからない画面（SAI サーバのペインなど） */
const NOT_A_PROMPT = '$ pnpm start\nSAI  http://127.0.0.1:8787/\n'

function summary(over: Partial<SessionSummary>): SessionSummary {
  return {
    id: 'S1@r',
    start: '',
    end: '2026-09-10T02:00:00+09:00',
    date: '',
    dates: [],
    agent: 'claude',
    agents: ['claude'],
    repo: 'r',
    repos: ['r'],
    project: '',
    projects: [],
    remote: '',
    branch: 'main',
    branches: [],
    host: '',
    hosts: [],
    cwd: '/tmp/r',
    turns: 1,
    waiting: '許可待ち: Bash: ls',
    title: 't',
    title_full: 't',
    session_source: 'payload',
    sources: [],
    last_text: '',
    model: '',
    models: [],
    permission_mode: '',
    pane: '%9',
    pid: 200,
    last_turn: '',
    terminal: { pane: '%9', pid: 200 },
    ...over,
  }
}

/** ペインの画面を決め打ちで返す tmux。`gone` ならペインが無い */
class FakeTmux implements Tmux {
  screen = CLAUDE_IDLE
  gone = false
  calls: string[][] = []
  async run(args: string[]): Promise<string> {
    this.calls.push(args)
    if (args[0] === 'display-message') {
      if (this.gone) throw new Error("can't find pane %9")
      return '100\n'
    }
    if (args[0] === 'capture-pane') return this.screen
    return ''
  }
}
/** pid 200 はペイン（100）の子孫 */
const ps = async () => ' 100     1\n 200   100\n'

test('WaitingSettle: ダイアログが消えていれば畳む（人が端末で答えた）', async () => {
  const tmux = new FakeTmux()
  const settle = new WaitingSettle(tmux, ps)
  tmux.screen = CLAUDE_IDLE
  assert.deepEqual([...(await settle.scan([summary({})]))], ['S1@r'])
  // 打ちかけがあってもダイアログではない（人は答えて、次を打ちかけている）
  tmux.screen = CLAUDE_TYPED
  assert.deepEqual([...(await settle.scan([summary({})]))], ['S1@r'])
})

test('WaitingSettle: ダイアログが出たままなら畳まない', async () => {
  const tmux = new FakeTmux()
  tmux.screen = CLAUDE_DIALOG
  assert.deepEqual([...(await new WaitingSettle(tmux, ps).scan([summary({})]))], [])
})

test('WaitingSettle: 分からないときは畳まない（材料が無いのに待ちを消さない）', async () => {
  // 入力欄が読めない（unknown）。古い行の pane が SAI サーバのペインを指しているとここに落ちる
  const unknown = new FakeTmux()
  unknown.screen = NOT_A_PROMPT
  assert.deepEqual([...(await new WaitingSettle(unknown, ps).scan([summary({})]))], [])

  // ペインが消えた
  const gone = new FakeTmux()
  gone.gone = true
  assert.deepEqual([...(await new WaitingSettle(gone, ps).scan([summary({})]))], [])

  // ペインで動いているのが別のプロセス（pid 999 はペインの子孫でない）
  const other = new FakeTmux()
  other.screen = CLAUDE_IDLE
  assert.deepEqual([...(await new WaitingSettle(other, ps).scan([summary({ terminal: { pane: '%9', pid: 999 } })]))], [])
})

test('WaitingSettle: 見に行くのは「端末で開いていて、行の上では待っている」ものだけ', async () => {
  const tmux = new FakeTmux()
  tmux.screen = CLAUDE_IDLE
  const settle = new WaitingSettle(tmux, ps)
  await settle.scan([
    summary({ id: 'a@r', waiting: '' }), // 待っていない
    summary({ id: 'b@r', terminal: null }), // 端末で開いていない
    summary({ id: 'c@r' }), // これだけ見る
  ])
  const panes = tmux.calls.filter((c) => c[0] === 'capture-pane')
  assert.equal(panes.length, 1, '待っていて端末で開いているものだけ capture する')
})

test('WaitingSettle: 3 秒のポーリングが重なっても走るスキャンは 1 本', async () => {
  const tmux = new FakeTmux()
  const settle = new WaitingSettle(tmux, ps)
  await Promise.all([settle.scan([summary({})]), settle.scan([summary({})]), settle.scan([summary({})])])
  assert.equal(tmux.calls.filter((c) => c[0] === 'capture-pane').length, 1)
})

test('WaitingSettle: Codex のセッションは Codex の入力欄で見る', async () => {
  const tmux = new FakeTmux()
  const codex = summary({ agent: 'codex', agents: ['codex'] })
  tmux.screen = 'some output\n› '
  assert.deepEqual([...(await new WaitingSettle(tmux, ps).scan([codex]))], ['S1@r'], 'Codex の空の入力欄は idle')
  const dialog = new FakeTmux()
  dialog.screen = '質問\n› 1. A\n  2. B\nEnter to select · Esc to cancel'
  assert.deepEqual([...(await new WaitingSettle(dialog, ps).scan([codex]))], [], 'ダイアログなら残す')
})

test('clearSettled: 畳んだぶんだけ waiting を空にする。他は同じオブジェクトのまま', () => {
  const a = summary({ id: 'a@r' })
  const b = summary({ id: 'b@r' })
  const out = clearSettled([a, b], new Set(['a@r']))
  assert.equal(out[0]!.waiting, '')
  assert.equal(out[1]!.waiting, '許可待ち: Bash: ls')
  assert.equal(out[1], b, '触らないものは作り直さない')
  assert.equal(a.waiting, '許可待ち: Bash: ls', '渡した配列の中身は書き換えない')

  const none = [a, b]
  assert.equal(clearSettled(none, new Set()), none, '畳むものが無ければ配列ごとそのまま')
})

test('settledKey: 集合が変われば鍵も変わる（並びには依らない）', () => {
  assert.equal(settledKey(new Set(['b', 'a'])), 'a,b')
  assert.equal(settledKey(new Set(['a', 'b'])), 'a,b')
  assert.notEqual(settledKey(new Set(['a'])), settledKey(new Set(['a', 'b'])))
  assert.equal(settledKey(new Set()), '')
})

test('NoWaitingSettle: SAI_TERMINAL=0 のときの実装は何も畳まない', async () => {
  assert.equal((await new NoWaitingSettle().scan()).size, 0)
})
