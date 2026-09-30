import assert from 'node:assert/strict'
import { mkdir, mkdtemp, realpath, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import test from 'node:test'
import {
  CODEX_PANES_TTL_MS,
  CodexPanes,
  lsofPaneFiles,
  parseCodexStart,
  parsePaneFiles,
  parsePsCommands,
  parseRolloutHead,
  rolloutSession,
  isClientOf,
  parseUnixSockets,
  rolloutSessionAtStart,
  sessionRoots,
} from './codexPanes.ts'
import type { CodexPaneDeps, StartProbe } from './codexPanes.ts'
import type { Tmux } from './terminal.ts'

/** ペイン 2 つ（%1 のシェル 100、%2 のシェル 200）と、その下の codex */
const PANES = '%1 100\n%2 200\n'
const PS = [
  '  100     1 -zsh',
  '  101   100 codex', // %1 の codex
  '  200     1 -zsh',
  '  201   200 node', // %2 は codex ではない
  '  300     1 /Applications/ChatGPT.app/Contents/Resources/codex', // tmux の外
].join('\n')

function fakeTmux(listed = PANES): Tmux & { calls: string[][] } {
  const calls: string[][] = []
  return {
    calls,
    async run(args: string[]) {
      calls.push(args)
      if (args[0] === 'list-panes') return listed
      throw new Error(`unexpected: ${args.join(' ')}`)
    },
  }
}

const SESSION = '01a06af3-618b-7eb3-bb03-a52279ff2235'
const OTHER = '01a06b05-0201-7d81-b47d-7466519583ff'
const THIRD = '01a06c00-0000-7000-8000-000000000003'

/** 本物の rollout（`session_meta` の 1 行だけ）を書く。返すのはそのパス */
async function writeRollout(dir: string, name: string, session: string, cwd: string): Promise<string> {
  const path = join(dir, name)
  await writeFile(path, `${JSON.stringify({ type: 'session_meta', payload: { session_id: session, cwd } })}\n`)
  return path
}

const deps = (over: Partial<CodexPaneDeps> = {}): CodexPaneDeps => ({
  tmux: fakeTmux(),
  ps: async () => PS,
  openOf: async () => ({ cwd: '/repo/one', rollouts: [] }),
  sessionAtStart: async () => '',
  ...over,
})

test('ペインで動いている codex を、行を見ずに見つける（#417）', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sai-panes-'))
  const rollout = await writeRollout(dir, `rollout-2026-09-04T14-40-23-${SESSION}.jsonl`, SESSION, '/repo/one')
  const panes = new CodexPanes(deps({ openOf: async () => ({ cwd: '/repo/one', rollouts: [rollout] }) }))
  assert.deepEqual(await panes.scan(), [{ pane: '%1', pid: 101, cwd: '/repo/one', session: SESSION }])
})

test('同じ cwd にもう 1 本セッションがあっても、ペインが開いている方を返す（#429）', async () => {
  // 端末で SESSION を開いたまま、SAI が同じ worktree に OTHER を起こした（#401）。
  // cwd から「一番新しい rollout」を引くと OTHER になり、SESSION 宛ての返信がこのペインに打ち込まれていた
  const dir = await mkdtemp(join(tmpdir(), 'sai-panes-'))
  const mine = await writeRollout(dir, `rollout-2026-09-04T14-40-23-${SESSION}.jsonl`, SESSION, '/repo/one')
  await writeRollout(dir, `rollout-2026-09-04T18-00-00-${OTHER}.jsonl`, OTHER, '/repo/one')
  const panes = new CodexPanes(deps({ openOf: async () => ({ cwd: '/repo/one', rollouts: [mine] }) }))
  assert.equal((await panes.scan())[0]?.session, SESSION)
})

test('tmux の外の codex は数えない（ChatGPT アプリの app-server など）', async () => {
  // 300 はどのペインの子孫でもない。ペインの中の node（201）も codex ではないので入らない
  const panes = new CodexPanes(deps())
  const found = await panes.scan()
  assert.deepEqual(found.map((p) => p.pid), [101])
})

test('rollout を 1 つも開いていない codex は、当てずに空で返す（呼ぶ側が捨てる）', async () => {
  const panes = new CodexPanes(deps({ openOf: async () => ({ cwd: '/repo/one', rollouts: [] }) }))
  assert.deepEqual((await panes.scan())[0]?.session, '')
})

test('rollout を閉じた TUI は、起動時刻で裏を取れたセッションを返す（#448）', async () => {
  const calls: [number, string, string][] = []
  const panes = new CodexPanes(
    deps({
      openOf: async () => ({ cwd: '/repo/one', rollouts: [] }),
      sessionAtStart: async (pid, cwd, pane) => {
        calls.push([pid, cwd, pane])
        return SESSION
      },
    }),
  )
  assert.equal((await panes.scan())[0]?.session, SESSION)
  assert.deepEqual(calls, [[101, '/repo/one', '%1']], 'ペインも渡す（スクロールバックを読むため）')
})

test('開いている rollout があれば起動時刻の補欠は呼ばない（#429 を優先）', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sai-panes-'))
  const rollout = await writeRollout(dir, `rollout-2026-09-04T14-40-23-${SESSION}.jsonl`, SESSION, '/repo/one')
  let fallbacks = 0
  const panes = new CodexPanes(
    deps({
      openOf: async () => ({ cwd: '/repo/one', rollouts: [rollout] }),
      sessionAtStart: async () => {
        fallbacks++
        return OTHER
      },
    }),
  )
  assert.equal((await panes.scan())[0]?.session, SESSION)
  assert.equal(fallbacks, 0)
})

test('rolloutSession: 開いているものの新しい順。読めないファイルは飛ばす', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sai-panes-'))
  const older = await writeRollout(dir, `rollout-2026-09-04T10-00-00-${SESSION}.jsonl`, SESSION, '/repo/one')
  const newer = await writeRollout(dir, `rollout-2026-09-04T20-00-00-${OTHER}.jsonl`, OTHER, '/repo/one')
  assert.equal(await rolloutSession([older, newer]), OTHER)
  assert.equal(await rolloutSession([join(dir, 'rollout-2026-09-04T21-00-00-nope.jsonl'), older]), SESSION)
  assert.equal(await rolloutSession([]), '')
})

test('parsePaneFiles: fcwd と、CODEX_HOME の下の rollout だけ', () => {
  const root = '/home/.codex/sessions/'
  const out = parsePaneFiles(
    [
      'p101',
      'fcwd',
      'n/repo/one',
      'ftxt',
      'n/usr/bin/codex',
      'f58',
      `n${root}2026/09/04/rollout-2026-09-04T14-40-23-${SESSION}.jsonl`,
      'f59',
      'n/tmp/rollout-2026-09-04T14-40-23-fake.jsonl', // 置き場の外は拾わない
      'f60',
      `n${root}2026/09/04/notes.jsonl`,
      '',
    ].join('\n'),
    [root],
  )
  assert.deepEqual(out, { cwd: '/repo/one', rollouts: [`${root}2026/09/04/rollout-2026-09-04T14-40-23-${SESSION}.jsonl`] })
})

test('結果は TTL の間覚える（3 秒のポーリングで ps も lsof も起こさない）', async () => {
  let now = 1_000_000
  let scans = 0
  const tmux = fakeTmux()
  const panes = new CodexPanes({ ...deps({ tmux }), ps: async () => { scans++; return PS }, now: () => now })
  await panes.scan()
  await panes.scan()
  assert.equal(scans, 1, 'TTL の中は走査し直さない')
  now += CODEX_PANES_TTL_MS + 1
  await panes.scan()
  assert.equal(scans, 2, '過ぎたら走査し直す')
})

test('tmux が無ければ前の結果を捨てない（「1 つも開いていない」と決めつけない）', async () => {
  let listed: string | Error = PANES
  const tmux: Tmux = { async run() { if (listed instanceof Error) throw listed; return listed } }
  let now = 1_000_000
  const panes = new CodexPanes({ ...deps({ tmux }), now: () => now })
  assert.equal((await panes.scan()).length, 1)
  listed = new Error('tmux: no server running')
  now += CODEX_PANES_TTL_MS + 1
  assert.equal((await panes.scan()).length, 1, '前に見つけた分を残す')
})

test('tmux が無いマシンでも TTL ぶんは起こし直さない（#435）', async () => {
  let runs = 0
  const tmux: Tmux = { async run() { runs++; throw new Error('tmux: command not found') } }
  let now = 1_000_000
  const panes = new CodexPanes({ ...deps({ tmux }), now: () => now })
  assert.deepEqual(await panes.scan(), [])
  assert.deepEqual(await panes.scan(), [])
  assert.equal(runs, 1, '失敗も覚えるので、TTL の中は tmux を起こし直さない')
  now += CODEX_PANES_TTL_MS + 1
  await panes.scan()
  assert.equal(runs, 2, '過ぎたらもう一度試す（tmux が戻っていれば拾える）')
})

test('parsePsCommands: pid / ppid / コマンド名（パスは落とす）', () => {
  assert.deepEqual(parsePsCommands('  101   100 /usr/local/bin/codex\n  bad line\n  102   100 node\n'), [
    { pid: 101, ppid: 100, comm: 'codex' },
    { pid: 102, ppid: 100, comm: 'node' },
  ])
})

test('parseCodexStart: ps の開始時刻と command を読む', () => {
  const parsed = parseCodexStart('Fri Sep 11 15:28:51 2026 codex\n')
  assert.equal(parsed?.startedAt.getFullYear(), 2026)
  assert.equal(parsed?.startedAt.getMonth(), 8)
  assert.equal(parsed?.startedAt.getDate(), 11)
  assert.equal(parsed?.startedAt.getHours(), 15)
  assert.equal(parsed?.startedAt.getMinutes(), 28)
  assert.equal(parsed?.startedAt.getSeconds(), 51)
  assert.equal(parsed?.command, 'codex')
  assert.equal(parseCodexStart('not ps'), null)
})

// ---------------------------------------------------------------- 起動時刻で当てる（#448 / #568）

const TUI = 101
const SERVER = 900
/** 実機の `lsof -a -U -p <pid> -F dn` の形。TUI（101）の 2 本目のソケットが app-server（900）の制御ソケットに繋いでいる */
const SERVER_SOCKETS = 'p900\nf7\nd0x63126b0e80b27db5\nn->0x0e41e2cf05b1bb1a\nf10\nd0x790df1f8a636a54a\nn/h/.codex/app-server-control/app-server-control.sock\n'
const TUI_SOCKETS = 'p101\nf7\nd0x225d86c96d365a1\nn->0x14fc9d3cdbe7babc\nf36\nd0x5507d69c003bc8b7\nn->0x790df1f8a636a54a\n'
const STRANGER_SOCKETS = 'p101\nf7\nd0xaaaa\nn->0xbbbb\n'

/** 使い捨ての CODEX_HOME。`marked` のスレッドには TUI が作った目印を置く */
async function codexHome(marked: string[] = [SESSION]) {
  const home = await mkdtemp(join(tmpdir(), 'sai-start-'))
  const dir = join(home, 'sessions', '2026', '09', '11')
  await mkdir(dir, { recursive: true })
  await mkdir(join(home, 'tui-thread-reference-capabilities'))
  for (const id of marked) await writeFile(join(home, 'tui-thread-reference-capabilities', id), '')
  return { home, dir }
}

/** 本物の外の読み取りの偽物。既定は「TUI は app-server 900 の客で、900 は起動時の rollout だけを開いている」 */
function probe(over: Partial<StartProbe> & { opened?: string[] } = {}): Partial<StartProbe> {
  return {
    ps: async () => 'Fri Sep 11 15:28:51 2026 codex\n',
    holders: async () => [SERVER],
    sockets: async (pid) => (pid === SERVER ? SERVER_SOCKETS : pid === TUI ? TUI_SOCKETS : ''),
    openRollouts: async () => over.opened ?? [],
    scrollback: async () => '',
    ...over,
  }
}

test('parseUnixSockets / isClientOf: 相手の番地がサーバの番地にあれば客', () => {
  const { addrs, peers } = parseUnixSockets(TUI_SOCKETS)
  assert.deepEqual([...addrs], ['0x225d86c96d365a1', '0x5507d69c003bc8b7'])
  assert.deepEqual([...peers], ['0x14fc9d3cdbe7babc', '0x790df1f8a636a54a'])
  assert.equal(isClientOf(TUI_SOCKETS, SERVER_SOCKETS), true)
  assert.equal(isClientOf(STRANGER_SOCKETS, SERVER_SOCKETS), false)
  assert.equal(isClientOf(TUI_SOCKETS, ''), false, 'サーバのソケットが読めなければ客とはみなさない')
})

test('rolloutSessionAtStart: 起動秒〜2 秒後・cwd・目印が揃った 1 本を、客である app-server が開いていれば当てる', async () => {
  const { home, dir } = await codexHome()
  const path = await writeRollout(dir, `rollout-2026-09-11T15-28-52-${SESSION}.jsonl`, SESSION, '/repo/one')
  const find = rolloutSessionAtStart({ CODEX_HOME: home }, probe({ opened: [path] }))
  assert.equal(await find(TUI, '/repo/one', '%1'), SESSION, '起動の 1 秒後の名前でも当てる（実測で 1 秒ずれた）')
  assert.equal(await find(TUI, '/repo/other', '%1'), '', 'cwd が違えば当てない')
})

test('rolloutSessionAtStart: 目印の無いスレッド（TUI が作っていない）は当てない', async () => {
  const { home, dir } = await codexHome([])
  await writeRollout(dir, `rollout-2026-09-11T15-28-51-${SESSION}.jsonl`, SESSION, '/repo/one')
  assert.equal(await rolloutSessionAtStart({ CODEX_HOME: home }, probe())(TUI, '/repo/one', '%1'), '')
})

test('rolloutSessionAtStart: 単発実行・subcommand・候補が 2 つは当てない', async () => {
  const { home, dir } = await codexHome([SESSION, OTHER])
  await writeRollout(dir, `rollout-2026-09-11T15-28-51-${SESSION}.jsonl`, SESSION, '/repo/one')
  const oneShot = rolloutSessionAtStart({ CODEX_HOME: home }, probe({ ps: async () => 'Fri Sep 11 15:28:51 2026 codex note.txtを読んで\n' }))
  assert.equal(await oneShot(TUI, '/repo/one', '%1'), '')
  const subcommand = rolloutSessionAtStart({ CODEX_HOME: home }, probe({ ps: async () => 'Fri Sep 11 15:28:51 2026 /usr/bin/codex app-server --stdio\n' }))
  assert.equal(await subcommand(TUI, '/repo/one', '%1'), '')
  await writeRollout(dir, `rollout-2026-09-11T15-28-52-${OTHER}.jsonl`, OTHER, '/repo/one')
  assert.equal(await rolloutSessionAtStart({ CODEX_HOME: home }, probe())(TUI, '/repo/one', '%1'), '')
})

test('rolloutSessionAtStart: その rollout を開いている app-server の客でなければ当てない', async () => {
  const { home, dir } = await codexHome()
  await writeRollout(dir, `rollout-2026-09-11T15-28-51-${SESSION}.jsonl`, SESSION, '/repo/one')
  const stranger = probe({ sockets: async (pid) => (pid === SERVER ? SERVER_SOCKETS : STRANGER_SOCKETS) })
  assert.equal(await rolloutSessionAtStart({ CODEX_HOME: home }, stranger)(TUI, '/repo/one', '%1'), '', '別の app-server の客')
  assert.equal(await rolloutSessionAtStart({ CODEX_HOME: home }, probe({ holders: async () => [] }))(TUI, '/repo/one', '%1'), '', '誰も開いていない')
})

test('rolloutSessionAtStart: その app-server が同じ cwd の別のスレッドを読み込んでいれば当てない（/new・/resume）', async () => {
  const { home, dir } = await codexHome()
  const path = await writeRollout(dir, `rollout-2026-09-11T15-28-51-${SESSION}.jsonl`, SESSION, '/repo/one')
  const later = join(home, 'sessions', '2026', '09', '12')
  await mkdir(later, { recursive: true })
  const elsewhere = await writeRollout(later, `rollout-2026-09-12T09-00-00-${OTHER}.jsonl`, OTHER, '/repo/other')
  const sameCwd = await writeRollout(later, `rollout-2026-09-12T09-00-01-${THIRD}.jsonl`, THIRD, '/repo/one')
  const find = (opened: string[]) => rolloutSessionAtStart({ CODEX_HOME: home }, probe({ opened }))(TUI, '/repo/one', '%1')
  assert.equal(await find([path, elsewhere]), SESSION, 'ほかの worktree のスレッド（別の TUI の会話）は構わない')
  assert.equal(await find([path, elsewhere, sameCwd]), '', '同じ worktree のスレッドも読み込んでいれば、どちらを映しているか分からない')
})

test('rolloutSessionAtStart: 起動後に書かれた同じ cwd の別の会話でも、その app-server が読み込んでいなければ当てる（#568）', async () => {
  // 手元の実例: dev-codex の TUI（起動 9/11）と同じ worktree の別の会話が 9/30 に書かれていたが、誰も開いておらず、
  // 行の pid も別のプロセスだった。#557 の「起動後に書かれていれば当てない」ではここで空に倒れていた
  const { home, dir } = await codexHome()
  const path = await writeRollout(dir, `rollout-2026-09-11T15-28-51-${SESSION}.jsonl`, SESSION, '/repo/one')
  const later = join(home, 'sessions', '2026', '09', '04')
  await mkdir(later, { recursive: true })
  await writeRollout(later, `rollout-2026-09-04T16-26-56-${THIRD}.jsonl`, THIRD, '/repo/one')
  assert.equal(await rolloutSessionAtStart({ CODEX_HOME: home }, probe({ opened: [path] }))(TUI, '/repo/one', '%1'), SESSION)
})

test('rolloutSessionAtStart: スクロールバックに `codex resume <id>` があれば（そのスレッドから離れた）当てない', async () => {
  const { home, dir } = await codexHome()
  await writeRollout(dir, `rollout-2026-09-11T15-28-51-${SESSION}.jsonl`, SESSION, '/repo/one')
  const panes: string[] = []
  const left = probe({
    scrollback: async (pane) => {
      panes.push(pane)
      return `To continue this session, run codex resume ${SESSION}\n`
    },
  })
  assert.equal(await rolloutSessionAtStart({ CODEX_HOME: home }, left)(TUI, '/repo/one', '%7'), '')
  assert.deepEqual(panes, ['%7'], 'そのペインのスクロールバックを読む')
  const unreadable = probe({ scrollback: async () => { throw new Error('no pane') } })
  assert.equal(await rolloutSessionAtStart({ CODEX_HOME: home }, unreadable)(TUI, '/repo/one', '%7'), '', 'スクロールバックを読めなければ当てない')
})

test('parseRolloutHead: session_meta の session_id と cwd（切れた行は捨てる）', () => {
  const head = [
    JSON.stringify({ type: 'session_meta', payload: { session_id: 'parent-1', id: 'child-1', cwd: '/repo/one' } }),
    JSON.stringify({ type: 'event_msg', payload: { type: 'task_started' } }),
    '{"type":"event_msg","payload":{"type":"切れた', // 頭の読み込みで切れた最後の行
  ].join('\n')
  assert.deepEqual(parseRolloutHead(head, 'file-uuid'), { cwd: '/repo/one', session: 'parent-1' })
  // レビューの子スレッドでも session_id は親を指す（#403）。無ければファイル名の UUID に落とす
  assert.deepEqual(parseRolloutHead(JSON.stringify({ type: 'turn_context', payload: { cwd: '/repo/two' } }), 'file-uuid'), {
    cwd: '/repo/two',
    session: 'file-uuid',
  })
  // git.repository_path しか無い形
  assert.deepEqual(parseRolloutHead(JSON.stringify({ payload: { git: { repository_path: '/repo/three' } } }), 'x').cwd, '/repo/three')
})

test('sessionRoots: シンボリックリンク越しの CODEX_HOME は、書いたとおりの形と realpath の両方を返す（#434）', async () => {
  // lsof が返すのは実パス（実測: `/tmp/…` は `/private/tmp/…`）。書いたとおりの形だけで前方一致を取ると、
  // 開いている rollout が 1 本も当たらず、例外も出ないままペインの Codex の検出が黙って何も返さない
  const tmp = await mkdtemp(join(tmpdir(), 'sai-roots-'))
  await mkdir(join(tmp, 'real', 'sessions'), { recursive: true })
  await symlink(join(tmp, 'real'), join(tmp, 'link'))
  const written = join(tmp, 'link', 'sessions')
  const real = await realpath(written)
  assert.notEqual(real, written, 'この一時ディレクトリではリンクが解ける（前提）')

  const roots = await sessionRoots(written)
  assert.deepEqual(roots, [written + sep, real + sep])

  // lsof が返す形（実パス）の rollout が拾える
  const path = join(real, '2026/09/24', `rollout-2026-09-24T14-40-23-${SESSION}.jsonl`)
  const out = parsePaneFiles(['p101', 'fcwd', 'n/repo/one', 'f58', `n${path}`, ''].join('\n'), roots)
  assert.deepEqual(out.rollouts, [path])
  // 書いたとおりの形だけで比べると落ちる（これが #434）
  assert.deepEqual(parsePaneFiles(['f58', `n${path}`, ''].join('\n'), [written + sep]).rollouts, [])
})

test('sessionRoots: 解けないディレクトリ（まだ Codex を動かしていない）は書いたとおりの形だけ（#434）', async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'sai-roots-'))
  const missing = join(tmp, 'nope', 'sessions')
  assert.deepEqual(await sessionRoots(missing), [missing + sep])
})

test('sessionRoots: リンクを挟まなければ 1 つだけ（同じ形を 2 回比べない）', async () => {
  const tmp = await realpath(await mkdtemp(join(tmpdir(), 'sai-roots-')))
  await mkdir(join(tmp, 'sessions'), { recursive: true })
  assert.deepEqual(await sessionRoots(join(tmp, 'sessions')), [join(tmp, 'sessions') + sep])
})

test('lsofPaneFiles: CODEX_HOME がリンク越しでも、lsof が返す実パスの rollout を拾う（#434）', async () => {
  // sessionRoots() と parsePaneFiles() の繋ぎ方まで含めて通す（`lsof` は起こさない）
  const tmp = await mkdtemp(join(tmpdir(), 'sai-lsof-'))
  await mkdir(join(tmp, 'real', 'sessions', '2026', '09', '24'), { recursive: true })
  await symlink(join(tmp, 'real'), join(tmp, 'link'))
  const real = await realpath(join(tmp, 'link', 'sessions'))
  const path = join(real, '2026/09/24', `rollout-2026-09-24T14-40-23-${SESSION}.jsonl`)
  // 実測の形（lsof はリンクを解いた実パスを返す）
  const output = ['p101', 'fcwd', 'n/repo/one', 'f58', `n${path}`, ''].join('\n')

  const open = lsofPaneFiles({ CODEX_HOME: join(tmp, 'link') }, async () => output)
  assert.deepEqual(await open(101), { cwd: '/repo/one', rollouts: [path] })
})

test('lsofPaneFiles: lsof が読めなければ空（今までどおり当てない）', async () => {
  const open = lsofPaneFiles({ CODEX_HOME: '/nope/.codex' }, async () => '')
  assert.deepEqual(await open(101), { cwd: '', rollouts: [] })
})
