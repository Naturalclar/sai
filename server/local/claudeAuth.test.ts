import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ClaudeAuth, NoClaudeAuth, parseAuthStatus } from './claudeAuth.ts'

test('parseAuthStatus: loggedIn と authMethod だけを読む。メールや組織は持たない。読めなければ undefined', () => {
  const real = JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty', email: 'me@example.com', orgId: 'o', orgName: 'Org', subscriptionType: 'max' })
  assert.deepEqual(parseAuthStatus(real), { loggedIn: true, method: 'claude.ai' })
  assert.deepEqual(parseAuthStatus('{"loggedIn":false}'), { loggedIn: false, method: '' })
  for (const bad of ['', 'not json', '[]', 'null', '{}', '{"loggedIn":"no"}']) assert.equal(parseAuthStatus(bad), undefined, bad)
})

async function withFake(script: string, fn: (bin: string, dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'sai-auth-'))
  try {
    const bin = join(dir, 'claude')
    await writeFile(bin, `#!/bin/sh\n${script}\n`)
    await chmod(bin, 0o755)
    await fn(bin, dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

test('ClaudeAuth: `auth status --json` の 1 形だけを叩き、非 0 で終わっても stdout を読む。続けて聞いても起こすのは 1 回', async () => {
  await withFake('echo "$@" >> "$(dirname "$0")/calls"; echo \'{"loggedIn":false,"authMethod":"none"}\'; exit 1', async (bin, dir) => {
    let now = 1000
    const auth = new ClaudeAuth(bin, 5000, 4000, () => now)
    assert.equal(auth.peek(), undefined, '聞く前は分からない')
    const [a, b] = await Promise.all([auth.check(), auth.check()])
    assert.deepEqual(a, { loggedIn: false, method: 'none' })
    assert.deepEqual(b, a)
    assert.deepEqual(auth.peek(), a)
    await auth.check()
    assert.equal(await readFile(join(dir, 'calls'), 'utf-8'), 'auth status --json\n', '走っている 1 本を待ち、TTL の間は聞き直さない')
    now += 6000
    await auth.check()
    assert.equal((await readFile(join(dir, 'calls'), 'utf-8')).split('\n').filter(Boolean).length, 2)
  })
})

test('ClaudeAuth: claude が無い・壊れた出力・時間切れは undefined（分からない）。前に「切れている」と聞いていても残さない', async () => {
  assert.equal(await new ClaudeAuth('/nonexistent/claude').check(), undefined)
  assert.equal(await new NoClaudeAuth().check(), undefined)
  await withFake('if [ -f "$(dirname "$0")/broken" ]; then echo "unknown command: auth"; else echo \'{"loggedIn":false}\'; fi', async (bin, dir) => {
    let now = 1000
    const auth = new ClaudeAuth(bin, 0, 4000, () => now++)
    assert.equal((await auth.check())?.loggedIn, false)
    await writeFile(join(dir, 'broken'), '')
    assert.equal(await auth.check(), undefined)
    assert.equal(auth.peek(), undefined)
  })
  await withFake('sleep 5', async (bin) => {
    assert.equal(await new ClaudeAuth(bin, 0, 100).check(), undefined)
  })
})
