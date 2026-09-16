import assert from 'node:assert/strict'
import test from 'node:test'
import { CODEX_PID_TTL_MS, CodexTerminals } from './codexTerminal.ts'

const SESSION = '01a06af3-618b-7eb3-bb03-a52279ff2235'
const env = { CODEX_HOME: '/codex-home' }
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
  assert.deepEqual(fake.paths, [`/codex-home/thread-writer-locks/${SESSION}.lock`], 'lock は CODEX_HOME の中だけ')
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
