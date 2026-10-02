// /sync-main を 1 本ずつにする lock（.claude/skills/sync-main/lock.sh。#580）。スキルの文面が呼ぶだけの小さいシェルなので、ここで回す
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const SCRIPT = fileURLToPath(new URL('../.claude/skills/sync-main/lock.sh', import.meta.url))

function run(...args: string[]): Promise<{ code: number; out: string; err: string }> {
  return new Promise((resolve) => {
    execFile('bash', [SCRIPT, ...args], (error, out, err) => {
      const code = error ? (typeof error.code === 'number' ? error.code : 1) : 0
      resolve({ code, out: out.trim(), err: err.trim() })
    })
  })
}

async function lockDir(): Promise<{ dir: string; lock: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'sai-sync-lock-'))
  return { dir, lock: join(dir, 'sai-sync-main.lock') }
}

test('sync-main の lock: 取って外す。外すのは取った本人だけ', async () => {
  const { dir, lock } = await lockDir()
  try {
    const a = await run('acquire', lock, 'a', '0')
    assert.equal(a.code, 0)
    assert.match(a.out, /^acquired/)
    assert.match((await run('status', lock)).out, /^held: a /)
    assert.equal((await run('release', lock, 'b')).code, 4, '他人の lock は外さない')
    assert.equal(existsSync(lock), true)
    assert.equal((await run('release', lock, 'a')).code, 0)
    assert.equal((await run('status', lock)).out, 'free')
    assert.equal((await run('release', lock, 'a')).code, 0, '無いものを外しても落ちない')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('sync-main の lock: 持たれている間は待ち、上限を超えたら 3 で返る（lock は奪わない）', async () => {
  const { dir, lock } = await lockDir()
  try {
    await run('acquire', lock, 'a', '0')
    const b = await run('acquire', lock, 'b', '0')
    assert.equal(b.code, 3)
    assert.match(b.out, /^timeout: a /)
    assert.equal((await readFile(join(lock, 'owner'), 'utf8')).trim(), 'a')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('sync-main の lock: 先の方が外したら、待っていた方が取る', async () => {
  const { dir, lock } = await lockDir()
  try {
    await run('acquire', lock, 'a', '0')
    const waiting = run('acquire', lock, 'b', '60')
    await new Promise((r) => setTimeout(r, 300))
    await run('release', lock, 'a')
    const b = await waiting
    assert.equal(b.code, 0)
    assert.equal((await readFile(join(lock, 'owner'), 'utf8')).trim(), 'b')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('sync-main の lock: 落ちたまま残った古い lock は引き取る', async () => {
  const { dir, lock } = await lockDir()
  try {
    await run('acquire', lock, 'dead', '0')
    await writeFile(join(lock, 'since'), `${Math.floor(Date.now() / 1000) - 1000}\n`)
    const fresh = await run('acquire', lock, 'b', '0', '2000')
    assert.equal(fresh.code, 3, 'まだ古くない')
    const b = await run('acquire', lock, 'b', '0', '900')
    assert.equal(b.code, 0)
    assert.match(b.err, /stale: dead/)
    assert.equal((await readFile(join(lock, 'owner'), 'utf8')).trim(), 'b')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('sync-main の lock: 同時に取りに行っても 1 つしか取れない', async () => {
  const { dir, lock } = await lockDir()
  try {
    const rs = await Promise.all(['a', 'b', 'c', 'd', 'e', 'f'].map((w) => run('acquire', lock, w, '0')))
    assert.equal(rs.filter((r) => r.code === 0).length, 1)
    assert.equal(rs.filter((r) => r.code === 3).length, 5)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('sync-main の lock: 古い lock を同時に引き取りに行っても、取れるのは 1 つ（引き取った人の lock を消さない）', async () => {
  const { dir, lock } = await lockDir()
  try {
    await run('acquire', lock, 'dead', '0')
    await writeFile(join(lock, 'since'), `${Math.floor(Date.now() / 1000) - 1000}\n`)
    const rs = await Promise.all(['a', 'b', 'c', 'd', 'e', 'f'].map((w) => run('acquire', lock, w, '3', '900')))
    const won = rs.filter((r) => r.code === 0)
    assert.equal(won.length, 1)
    assert.equal(rs.filter((r) => r.code === 3).length, 5)
    assert.equal(existsSync(`${lock}.takeover`), false)
    assert.equal(existsSync(join(lock, 'owner')), true)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
