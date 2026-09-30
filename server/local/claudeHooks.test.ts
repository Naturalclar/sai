import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chmod, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ClaudeHooks, reachesRecord } from './claudeHooks.ts'
import { EXPECTED_CLAUDE_HOOKS } from '../../shared/hooks.ts'

test('reachesRecord: 直書き・PATH のラッパーの中身・~ と $HOME を開いた先を見る', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sai-hooks-bin-'))
  try {
    await writeFile(join(dir, 'sai-record'), '#!/bin/sh\nexec python3 "$SAI_HOME/feed/record.py" "$@"\n')
    await writeFile(join(dir, 'notify-sound'), '#!/bin/sh\nafplay x.aiff\n')
    await chmod(join(dir, 'sai-record'), 0o755)
    const reaches = reachesRecord({ path: dir, home: dir })
    assert.equal(reaches('python3 "$SAI_HOME/feed/record.py" || true'), true)
    assert.equal(reaches('sai-record'), true)
    assert.equal(reaches('sai-record --agent claude'), true)
    assert.equal(reaches('"sai-record"'), true)
    assert.equal(reaches('~/sai-record'), true)
    assert.equal(reaches('$HOME/sai-record'), true)
    assert.equal(reaches('notify-sound'), false, '中身が record.py を呼ばない')
    assert.equal(reaches('not-on-path'), false)
    assert.equal(reaches(''), false)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('ClaudeHooks: 足りないものを出す。ttl の間は読み直さず、mtime が変わったら読み直す。読めなければ null', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sai-hooks-'))
  try {
    const path = join(dir, 'settings.json')
    const reaches = (cmd: string) => cmd.includes('record.py')
    const hooks = new ClaudeHooks([path], { ttlMs: 1000, reaches })
    assert.equal(hooks.missing(0), null, '無ければ分からない')

    const all = Object.fromEntries(EXPECTED_CLAUDE_HOOKS.map((h) => [h.event, [{ ...(h.matcher ? { matcher: h.matcher } : {}), hooks: [{ type: 'command', command: 'record.py' }] }]]))
    const { SessionEnd: _end, ...partial } = all
    await writeFile(path, JSON.stringify({ hooks: partial }))
    await utimes(path, 1, 1)
    assert.equal(hooks.missing(500), null, 'ttl の間は前の答え')
    assert.deepEqual(hooks.missing(1500), ['SessionEnd'])

    await writeFile(path, JSON.stringify({ hooks: all }))
    await utimes(path, 2, 2)
    assert.deepEqual(hooks.missing(3000), [], '直したら消える')

    await writeFile(path, '{ broken')
    await utimes(path, 3, 3)
    assert.equal(hooks.missing(5000), null, '壊れていたら分からない')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
