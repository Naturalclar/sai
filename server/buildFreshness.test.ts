import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BuildFreshness, defaultSourceDirs, newestMtime } from './buildFreshness.ts'

/** path の mtime を base から sec 秒ずらす */
async function touch(path: string, base: number, sec: number) {
  const t = new Date(base + sec * 1000)
  await utimes(path, t, t)
}

test('defaultSourceDirs: web/dist から見て web/src, web/index.html, shared', () => {
  assert.deepEqual(defaultSourceDirs('/repo/web/dist'), ['/repo/web/src', '/repo/web/index.html', '/repo/shared'])
})

test('newestMtime: 再帰で一番新しい mtime。テスト・node_modules・dist・無いパスは飛ばす', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sai-fresh-'))
  try {
    const base = Date.now() - 600_000
    await mkdir(join(dir, 'src', 'deep'), { recursive: true })
    await mkdir(join(dir, 'src', 'node_modules'), { recursive: true })
    await writeFile(join(dir, 'src', 'a.ts'), '')
    await writeFile(join(dir, 'src', 'deep', 'b.ts'), '')
    await writeFile(join(dir, 'src', 'a.test.ts'), '')
    await writeFile(join(dir, 'src', 'node_modules', 'x.js'), '')
    await touch(join(dir, 'src', 'a.ts'), base, 10)
    await touch(join(dir, 'src', 'deep', 'b.ts'), base, 20)
    await touch(join(dir, 'src', 'a.test.ts'), base, 90)
    await touch(join(dir, 'src', 'node_modules', 'x.js'), base, 90)
    const newest = await newestMtime([join(dir, 'src'), join(dir, 'nope')])
    assert.equal(Math.round((newest ?? 0) / 1000), Math.round((base + 20_000) / 1000), 'deep/b.ts が一番新しい。test と node_modules は数えない')
    assert.equal(await newestMtime([join(dir, 'nope')]), null)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('BuildFreshness: dist が古ければ stale、新しければ違う。dist 無し・ソース無しは stale ではない。ttl 内は再走査しない', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sai-fresh-'))
  try {
    const base = Date.now() - 600_000
    const dist = join(dir, 'dist')
    const src = join(dir, 'src')
    await mkdir(dist)
    await mkdir(src)
    const noDist = new BuildFreshness(join(dir, 'nodist'), [src], 0)
    assert.equal(await noDist.stale(), false, '未ビルドは「古い」ではない（別の案内が出る）')

    await writeFile(join(dist, 'index.html'), '')
    await touch(join(dist, 'index.html'), base, 100)
    const noSrc = new BuildFreshness(dist, [join(dir, 'nope')], 0)
    assert.equal(await noSrc.stale(), false, 'ソースが見つからなければ判定しない')

    await writeFile(join(src, 'a.ts'), '')
    await touch(join(src, 'a.ts'), base, 50)
    const f = new BuildFreshness(dist, [src], 0)
    assert.equal(await f.stale(), false, 'dist(100) の方が新しい')

    await touch(join(src, 'a.ts'), base, 200)
    assert.equal(await f.stale(), true, 'ソース(200) の方が新しい')

    await touch(join(dist, 'index.html'), base, 300)
    assert.equal(await f.stale(), false, 'ビルドし直したら戻る')

    // ttl 内は前の答えを返す
    const cached = new BuildFreshness(dist, [src], 60_000)
    const t0 = 1_000_000
    assert.equal(await cached.stale(t0), false)
    await touch(join(src, 'a.ts'), base, 400)
    assert.equal(await cached.stale(t0 + 1_000), false, 'まだ ttl 内')
    assert.equal(await cached.stale(t0 + 61_000), true, 'ttl を過ぎたら再走査')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
