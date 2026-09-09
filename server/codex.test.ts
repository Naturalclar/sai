import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mkdtemp } from 'node:fs/promises'
import { codexWriterActive, codexWriterLockPath } from './codex.ts'

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
