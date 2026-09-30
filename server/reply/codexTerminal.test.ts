import assert from 'node:assert/strict'
import test, { after } from 'node:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CODEX_PID_TTL_MS, CodexTerminals, isClientOf, paneClientOf, parseUnixSockets } from './codexTerminal.ts'

const SESSION = '01a06af3-618b-7eb3-bb03-a52279ff2235'
const root = await mkdtemp(join(tmpdir(), 'sai-codex-terminal-'))
const locks = join(root, 'thread-writer-locks')
await mkdir(locks)
await writeFile(join(locks, `${SESSION}.lock`), '')
after(() => rm(root, { recursive: true, force: true }))
const env = { CODEX_HOME: root }
const PANE = '%262'
/** 既定では、どの pid もそのペインの中にいる扱い（ペインの検査そのものは inspectPrompt と同じ isDescendant） */
const inPane = async () => true

/** `lsof -t <lock>` の偽物。呼ばれた path を覚える */
function fakeHolders(pids: number[] | Error) {
  const paths: string[] = []
  return {
    paths,
    holders: async (path: string) => {
      paths.push(path)
      if (pids instanceof Error) throw pids
      return pids
    },
  }
}

test('lock を握っている生きたプロセスを本体として返す（#332）', async () => {
  const fake = fakeHolders([83438])
  const codex = new CodexTerminals({ holders: fake.holders, alive: (pid) => pid === 83438, inPane, env })
  assert.equal(await codex.pid(SESSION, PANE), 83438)
  assert.deepEqual(fake.paths, [join(locks, `${SESSION}.lock`)], 'lock は CODEX_HOME の中だけ')
})

test('死んでいる holder（lock の残骸）は本体にしない', async () => {
  const fake = fakeHolders([11111])
  const codex = new CodexTerminals({ holders: fake.holders, alive: () => false, inPane, env })
  assert.equal(await codex.pid(SESSION, PANE), 0)
})

test('合成 ID は lock を引かない（置き場を組み立てられない）', async () => {
  const fake = fakeHolders([83438])
  const codex = new CodexTerminals({ holders: fake.holders, alive: () => true, inPane, env })
  assert.equal(await codex.pid('synth-tmp-20260910T000726', PANE), 0)
  assert.deepEqual(fake.paths, [], 'lsof も起こさない')
})

test('lock ファイルが無いセッションは lsof を起こさない（#432）', async () => {
  const fake = fakeHolders([83438])
  const missing = '01a06af3-618b-7eb3-bb03-a52279ff9999'
  const codex = new CodexTerminals({ holders: fake.holders, alive: () => true, inPane, env })
  assert.equal(await codex.pid(missing, PANE), 0)
  assert.deepEqual(fake.paths, [])
})

test('lsof が使えなければ 0（端末扱いにしない）', async () => {
  const fake = fakeHolders(new Error('spawn lsof ENOENT'))
  const codex = new CodexTerminals({ holders: fake.holders, alive: () => true, inPane, env })
  assert.equal(await codex.pid(SESSION, PANE), 0, 'codexWriterActive() と違って、分からないときは端末にしない')
})

test('TTL の間は覚えている。見つからなかったことも覚える（3 秒のポーリングで lsof を起こさない）', async () => {
  const fake = fakeHolders([83438])
  let now = 1_000_000
  const codex = new CodexTerminals({ holders: fake.holders, alive: () => true, inPane, now: () => now, env })
  assert.equal(await codex.pid(SESSION, PANE), 83438)
  assert.equal(await codex.pid(SESSION, PANE), 83438)
  assert.equal(fake.paths.length, 1, 'TTL の中は聞き直さない')
  now += CODEX_PID_TTL_MS + 1
  assert.equal(await codex.pid(SESSION, PANE), 83438)
  assert.equal(fake.paths.length, 2, '過ぎたら聞き直す')

  const miss = fakeHolders([])
  const none = new CodexTerminals({ holders: miss.holders, alive: () => true, inPane, now: () => now, env })
  assert.equal(await none.pid(SESSION, PANE), 0)
  assert.equal(await none.pid(SESSION, PANE), 0)
  assert.equal(miss.paths.length, 1, '見つからなかったことも覚える')
})

test('覚えている pid が死んだら、TTL の中でも引き直す', async () => {
  let live = 83438
  const paths: string[] = []
  const codex = new CodexTerminals({
    holders: async (path) => {
      paths.push(path)
      return [live]
    },
    alive: (pid) => pid === live,
    inPane,
    now: () => 1_000_000,
    env,
  })
  assert.equal(await codex.pid(SESSION, PANE), 83438)
  // 端末を閉じて、別の Codex が同じセッションを開き直した
  live = 90000
  assert.equal(await codex.pid(SESSION, PANE), 90000, '死んだ pid を「開いている」と言い続けない')
  assert.equal(paths.length, 2)
})

test('lock を握っているのがそのペインの外のプロセスなら本体にしない（#332）', async () => {
  // 実測: ChatGPT アプリの `codex app-server --listen` がそのスレッドの lock を握っていた（ppid 1、どのペインの子孫でもない）。
  // 行の pane と並べて「端末で開いている」と答えると、画面の印も打ち込み先も嘘になる
  const fake = fakeHolders([46927, 83438])
  const codex = new CodexTerminals({
    holders: fake.holders,
    alive: () => true,
    inPane: async (pane, pid) => pane === PANE && pid === 83438,
    env,
  })
  assert.equal(await codex.pid(SESSION, PANE), 83438, 'そのペインの中にいる方を選ぶ')

  const outside = new CodexTerminals({ holders: fakeHolders([46927]).holders, alive: () => true, inPane: async () => false, env })
  assert.equal(await outside.pid(SESSION, PANE), 0, 'ペインの外だけなら端末扱いにしない')
})

// ---------------------------------------------------------------- 行の pid がペインの外（#562）

/** 実機（2026-09-30）の `lsof -a -U -p <pid> -F dn` の形。app-server（46927）の制御ソケットに TUI（30068）が繋いでいる */
const SERVER_SOCKETS = 'p46927\nf7\nd0x63126b0e80b27db5\nn->0x0e41e2cf05b1bb1a\nf10\nd0x790df1f8a636a54a\nn/Users/me/.codex/app-server-control/app-server-control.sock\n'
const TUI_SOCKETS = 'p30068\nf7\nd0x225d86c96d365a1\nn->0x14fc9d3cdbe7babc\nf36\nd0x5507d69c003bc8b7\nn->0x790df1f8a636a54a\n'
const OTHER_SOCKETS = 'p30099\nf7\nd0xaaaa\nn->0xbbbb\n'

test('parseUnixSockets: 自分の番地と相手の番地を分けて読む', () => {
  const { addrs, peers } = parseUnixSockets(TUI_SOCKETS)
  assert.deepEqual([...addrs], ['0x225d86c96d365a1', '0x5507d69c003bc8b7'])
  assert.deepEqual([...peers], ['0x14fc9d3cdbe7babc', '0x790df1f8a636a54a'])
})

test('isClientOf: 相手の番地がサーバの番地にあれば客', () => {
  assert.equal(isClientOf(TUI_SOCKETS, SERVER_SOCKETS), true)
  assert.equal(isClientOf(OTHER_SOCKETS, SERVER_SOCKETS), false)
  assert.equal(isClientOf(TUI_SOCKETS, ''), false, 'サーバのソケットが読めなければ客とはみなさない')
})

test('paneClientOf: そのペインの中の codex のうち、app-server に繋いでいるものを返す', async () => {
  const rows = [
    { pid: 10771, ppid: 1, comm: 'zsh' },
    { pid: 30068, ppid: 10771, comm: 'codex' },
    { pid: 30099, ppid: 1, comm: 'codex' }, // ペインの外
    { pid: 46927, ppid: 1, comm: 'codex' }, // app-server
  ]
  const out: Record<number, string> = { 46927: SERVER_SOCKETS, 30068: TUI_SOCKETS, 30099: TUI_SOCKETS }
  const sockets = async (pid: number) => out[pid] ?? ''
  assert.equal(await paneClientOf(46927, 10771, rows, sockets), 30068)
  // 同じペインにいても app-server に繋いでいなければ当てない
  assert.equal(await paneClientOf(46927, 10771, rows, async (pid) => (pid === 30068 ? OTHER_SOCKETS : out[pid] ?? '')), 0)
  // ペインに codex がいなければ lsof を起こさない
  const asked: number[] = []
  assert.equal(await paneClientOf(46927, 555, rows, async (pid) => (asked.push(pid), out[pid] ?? '')), 0)
  assert.deepEqual(asked, [])
})

test('owner: 行の pid がペインの中ならそのまま、外ならペインの客、どちらでもなければ 0（#562）', async () => {
  const clients: [string, number][] = []
  const make = (client: number) =>
    new CodexTerminals({
      env,
      alive: () => true,
      inPane: async (_pane, pid) => pid === 200,
      paneClient: async (pane, server) => {
        clients.push([pane, server])
        return client
      },
    })
  assert.equal(await make(30068).owner(PANE, 200), 200, 'ペインの中の pid はそのまま（客を探さない）')
  assert.deepEqual(clients, [])
  assert.equal(await make(30068).owner(PANE, 46927), 30068, 'app-server の客の TUI を端末にする')
  assert.equal(await make(0).owner(PANE, 46927), 0, 'ペインの外で客もいなければ端末にしない')
  assert.deepEqual(clients, [[PANE, 46927], [PANE, 46927]])
})

test('owner: TTL の間は覚えていて、lastOwner は前回の結果を返す', async () => {
  let now = 0
  let asked = 0
  const t = new CodexTerminals({
    env,
    alive: () => true,
    inPane: async () => false,
    paneClient: async () => (asked++, 30068),
    now: () => now,
  })
  assert.equal(t.lastOwner(PANE, 46927), undefined, 'まだ引いていなければ知らない')
  assert.equal(await t.owner(PANE, 46927), 30068)
  assert.equal(await t.owner(PANE, 46927), 30068)
  assert.equal(asked, 1)
  assert.equal(t.lastOwner(PANE, 46927), 30068)
  now += CODEX_PID_TTL_MS
  await t.owner(PANE, 46927)
  assert.equal(asked, 2)
})
