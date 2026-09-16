import assert from 'node:assert/strict'
import test from 'node:test'
import { CODEX_PANES_TTL_MS, CodexPanes, parsePsCommands, parseRolloutHead } from './codexPanes.ts'
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

const deps = (over: Partial<CodexPaneDeps> = {}): CodexPaneDeps => ({
  tmux: fakeTmux(),
  ps: async () => PS,
  cwdOf: async (pid: number) => (pid === 101 ? '/repo/one' : ''),
  sessionOf: async (cwd: string) => (cwd === '/repo/one' ? '01a06af3-618b-7eb3-bb03-a52279ff2235' : ''),
  ...over,
})

test('ペインで動いている codex を、行を見ずに見つける（#417）', async () => {
  const panes = new CodexPanes(deps())
  assert.deepEqual(await panes.scan(), [
    { pane: '%1', pid: 101, cwd: '/repo/one', session: '01a06af3-618b-7eb3-bb03-a52279ff2235' },
  ])
})

test('tmux の外の codex は数えない（ChatGPT アプリの app-server など）', async () => {
  // 300 はどのペインの子孫でもない。ペインの中の node（201）も codex ではないので入らない
  const panes = new CodexPanes(deps({ cwdOf: async () => '/repo/one' }))
  const found = await panes.scan()
  assert.deepEqual(found.map((p) => p.pid), [101])
})

test('セッションが引けない codex も返す（まだスレッドが無い）。呼ぶ側が捨てる', async () => {
  const panes = new CodexPanes(deps({ sessionOf: async () => '' }))
  assert.deepEqual((await panes.scan())[0]?.session, '')
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
