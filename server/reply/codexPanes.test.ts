import assert from 'node:assert/strict'
import { mkdir, mkdtemp, realpath, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import test from 'node:test'
import { CODEX_PANES_TTL_MS, CodexPanes, parsePaneFiles, parsePsCommands, parseRolloutHead, rolloutSession, sessionRoots, lsofPaneFiles } from './codexPanes.ts'
import type { CodexPaneDeps } from './codexPanes.ts'
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

test('parsePsCommands: pid / ppid / コマンド名（パスは落とす）', () => {
  assert.deepEqual(parsePsCommands('  101   100 /usr/local/bin/codex\n  bad line\n  102   100 node\n'), [
    { pid: 101, ppid: 100, comm: 'codex' },
    { pid: 102, ppid: 100, comm: 'node' },
  ])
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
