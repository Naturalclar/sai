import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, open, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mkdtemp } from 'node:fs/promises'
import { codexQueueCommand, codexWriterActive, codexWriterLockPath, lsofHolders, runCodexQueue } from './codex.ts'

const SESSION = '01a06b50-3e5e-77d3-9f93-6c61bbbc5467'

test('Codex の writer lock は、開いているプロセスがいるときだけ active とみなす（#160 / #329）', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sai-codex-'))
  try {
    const locks = join(root, 'thread-writer-locks')
    await mkdir(locks)
    const lock = join(locks, `${SESSION}.lock`)
    await writeFile(lock, '')
    const seen: string[] = []
    const held = async (path: string) => {
      seen.push(path)
      return [4242]
    }
    assert.equal(await codexWriterActive(SESSION, { CODEX_HOME: root }, held), true)
    assert.deepEqual(seen, [lock], '見るのは lock のファイルそのもの')
    // Codex が終わっても lock のファイルは残る（C-c・サーバの立て直しで app-server ごと落ちたとき）。誰も開いていなければ閉じている
    assert.equal(await codexWriterActive(SESSION, { CODEX_HOME: root }, async () => []), false)
    // 確かめる手段が無い（lsof が無い）ときは、今までどおり lock があれば開いている扱い
    const noLsof = async () => {
      throw Object.assign(new Error('spawn lsof ENOENT'), { code: 'ENOENT' })
    }
    assert.equal(await codexWriterActive(SESSION, { CODEX_HOME: root }, noLsof), true)
    assert.equal(await codexWriterActive('01a06b50-3e5e-77d3-9f93-000000000000', { CODEX_HOME: root }, held), false)
    assert.equal(seen.length, 1, 'lock が無ければ lsof も叩かない')
    assert.equal(codexWriterLockPath('../../outside', { CODEX_HOME: root }), null, 'ID から CODEX_HOME の外を読ませない')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('lsofHolders: 本物の lsof で、開いているプロセスがいればその pid、いなければ空', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'sai-lsof-'))
  const lock = join(root, 'x.lock')
  await writeFile(lock, '')
  try {
    try {
      assert.deepEqual(await lsofHolders(lock), [], '誰も開いていない（lsof は 1 で終わる）')
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return t.skip('lsof が無い')
      throw err
    }
    const handle = await open(lock, 'r')
    try {
      assert.deepEqual(await lsofHolders(lock), [process.pid], 'このプロセスが開いている')
    } finally {
      await handle.close()
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('active Codex への返信は exec resume ではなく queue コマンドにする', () => {
  assert.deepEqual(
    // SAI_CODEX_BIN はもう読まない。実行ファイルはサーバの PATH の codex（#288）
    codexQueueCommand(SESSION, '-から始まる\n本文', '/work', { SAI_CODEX_BIN: '/opt/codex', SAI_CODEX_ARGS: '-s workspace-write' }, 'gpt-5', ['/tmp/a.png']),
    {
      bin: 'codex',
      args: ['queue', '-s', 'workspace-write', '-m', 'gpt-5', '-i', '/tmp/a.png', '--thread', SESSION, '--message', '-から始まる\n本文'],
      cwd: '/work',
      text: '-から始まる\n本文',
    },
  )
})

test('queue は終了コードまで待ち、CLI の失敗理由を返す', async () => {
  await runCodexQueue({ bin: process.execPath, args: ['-e', ''], cwd: process.cwd(), text: 'ok' })
  await assert.rejects(
    runCodexQueue({ bin: process.execPath, args: ['-e', 'process.stderr.write("queue failed"); process.exit(1)'], cwd: process.cwd(), text: 'ng' }),
    /queue failed/,
  )
})

test('queue の子にも TMUX_PANE を渡さない（#234）', async () => {
  const before = process.env.TMUX_PANE
  const dir = await mkdtemp(join(tmpdir(), 'sai-codex-'))
  try {
    process.env.TMUX_PANE = '%249'
    const out = join(dir, 'seen.txt')
    const code = `require('fs').writeFileSync(${JSON.stringify(out)}, String(process.env.TMUX_PANE ?? '(unset)'))`
    await runCodexQueue({ bin: process.execPath, args: ['-e', code], cwd: process.cwd(), text: 'x' })
    assert.equal(await readFile(out, 'utf-8'), '(unset)')
  } finally {
    if (before === undefined) delete process.env.TMUX_PANE
    else process.env.TMUX_PANE = before
    await rm(dir, { recursive: true, force: true })
  }
})
