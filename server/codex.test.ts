import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mkdtemp } from 'node:fs/promises'
import { codexQueueCommand, codexWriterActive, codexWriterLockPath, runCodexQueue } from './codex.ts'

const SESSION = '01a06b50-3e5e-77d3-9f93-6c61bbbc5467'

test('Codex の writer lock があるセッションだけ active とみなす（#160）', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sai-codex-'))
  try {
    const locks = join(root, 'thread-writer-locks')
    await mkdir(locks)
    await writeFile(join(locks, `${SESSION}.lock`), '')
    assert.equal(await codexWriterActive(SESSION, { CODEX_HOME: root }), true)
    assert.equal(await codexWriterActive('01a06b50-3e5e-77d3-9f93-000000000000', { CODEX_HOME: root }), false)
    assert.equal(codexWriterLockPath('../../outside', { CODEX_HOME: root }), null, 'ID から CODEX_HOME の外を読ませない')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('active Codex への返信は exec resume ではなく queue コマンドにする', () => {
  assert.deepEqual(
    codexQueueCommand(SESSION, '-から始まる\n本文', '/work', { SAI_CODEX_BIN: '/opt/codex', SAI_CODEX_ARGS: '-s workspace-write' }, 'gpt-5', ['/tmp/a.png']),
    {
      bin: '/opt/codex',
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
