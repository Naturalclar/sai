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

test('ClaudeAuth.refresh: TTL の中でも聞き直す。走っている聞き直しの結果は使わず次の 1 回を分け合い、聞けなかったら前の結果を残す（#577）', async () => {
  // 状態は起動した瞬間に読み、読んでから `calls` に 1 行足す。`slow` があれば、`go` が置かれるまで答えない（時間に頼らない）
  await withFake('d="$(dirname "$0")"; if [ -f "$d/in" ]; then v=true; else v=false; fi; echo x >> "$d/calls"; if [ -f "$d/slow" ]; then while [ ! -f "$d/go" ]; do sleep 0.05; done; fi; if [ -f "$d/broken" ]; then echo "oops"; else echo "{\\"loggedIn\\":$v}"; fi', async (bin, dir) => {
    const calls = async () => (await readFile(join(dir, 'calls'), 'utf-8')).split('\n').filter(Boolean).length
    const auth = new ClaudeAuth(bin, 60_000, 4000, () => 1000)
    assert.equal((await auth.check())?.loggedIn, false)
    await auth.check()
    assert.equal(await calls(), 1, 'check は TTL の間は聞き直さない')
    const [a, b, c] = await Promise.all([auth.refresh(), auth.refresh(), auth.refresh()])
    assert.deepEqual([a?.loggedIn, b?.loggedIn, c?.loggedIn], [false, false, false])
    // 1 つ目が聞いている間に来た 2 つは、その結果を使わず（始まったあとの変化を見ていないかもしれない）、次の 1 回を分け合う
    assert.equal(await calls(), 3, '同時の 3 回で起こすのは 2 回（走っている分と、そのあとの 1 回）')
    // 聞いている途中で状態が変わったら（ログインの子が資格情報を書いた）、あとから来た聞き直しは新しい方を返す
    await writeFile(join(dir, 'slow'), '')
    const before = await calls()
    const early = auth.refresh()
    // 1 本目が状態を読み終えるまで待ってから、状態を変える
    while ((await calls()) === before) await new Promise((r) => setTimeout(r, 20))
    await writeFile(join(dir, 'in'), '')
    const late = auth.refresh()
    await writeFile(join(dir, 'go'), '')
    assert.equal((await early)?.loggedIn, false)
    assert.equal((await late)?.loggedIn, true, '走っていた分（変わる前に読んだ）の結果を返さない')
    await rm(join(dir, 'slow'))
    await rm(join(dir, 'go'))
    await rm(join(dir, 'in'))
    assert.equal((await auth.refresh())?.loggedIn, false)
    await writeFile(join(dir, 'broken'), '')
    assert.equal(await auth.refresh(), undefined, '返すのは「分からない」')
    assert.equal(auth.peek()?.loggedIn, false, '前の「切れている」は残す（押しただけでバナーを消さない）')
  })
})
