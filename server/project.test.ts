import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { RealGit } from './diff.ts'
import type { Git } from './diff.ts'
import { fillProjects, ProjectResolver } from './project.ts'

const run = promisify(execFile)
const git = async (cwd: string, ...args: string[]) => {
  await run('git', ['-C', cwd, '-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args])
}

/** cwd ごとに決められた答えを返し、何回叩かれたかを覚える */
class FakeGit implements Git {
  calls: { cwd: string; args: string[] }[] = []
  answers = new Map<string, string>()
  async run(cwd: string, args: string[]): Promise<string> {
    this.calls.push({ cwd, args })
    const key = `${cwd} ${args.join(' ')}`
    const hit = this.answers.get(key)
    if (hit === undefined) throw new Error(`fake: ${key}`)
    return hit
  }
}

test('ProjectResolver: origin があれば owner/repo、無ければ common-dir からリポジトリ名', async () => {
  const g = new FakeGit()
  g.answers.set('/w/sai.git/dev-min remote get-url origin', 'git@github.com:Naturalclar/sai.git\n')
  g.answers.set('/w/local/wt rev-parse --git-common-dir', '/w/local.git\n')
  const r = new ProjectResolver(g)
  assert.equal(await r.resolve('/w/sai.git/dev-min'), 'Naturalclar/sai', 'remote から来た行と同じ形（候補が割れない）')
  assert.equal(await r.resolve('/w/local/wt'), 'local', 'origin が無ければ名前だけ')
})

test('ProjectResolver: 引けなくても覚える（同じ cwd を何度も叩かない）', async () => {
  const g = new FakeGit()
  g.answers.set('/w/ok remote get-url origin', 'https://github.com/o/r.git\n')
  const r = new ProjectResolver(g)
  assert.equal(await r.resolve('/w/ok'), 'o/r')
  assert.equal(await r.resolve('/w/ok'), 'o/r')
  assert.equal(g.calls.length, 1, '2 回目はキャッシュ')

  // git が読めない cwd。空を覚えるので 2 回目は叩かない
  const before = g.calls.length
  assert.equal(await r.resolve('/w/gone'), '')
  const after = g.calls.length
  assert.equal(await r.resolve('/w/gone'), '')
  assert.equal(g.calls.length, after, '引けなかったことも覚える')
  assert.ok(after > before)
  assert.equal(await r.resolve(''), '', 'cwd が空なら git を叩かない')
  assert.equal(g.calls.length, after)
})

test('fillProjects: project の空いているセッションだけ埋める。埋まらなければ空のまま', async () => {
  const g = new FakeGit()
  g.answers.set('/w/a remote get-url origin', 'https://github.com/o/a.git\n')
  const r = new ProjectResolver(g)
  const sessions = [
    { id: '1', cwd: '/w/a', project: '', projects: [] as string[] },
    { id: '2', cwd: '/w/a', project: '', projects: [] as string[] },
    { id: '3', cwd: '/w/gone', project: '', projects: [] as string[] },
    { id: '4', cwd: '/w/b', project: 'o/known', projects: ['o/known'] },
  ]
  const out = await fillProjects(r, sessions)
  assert.deepEqual(
    out.map((s) => [s.id, s.project, s.projects]),
    [
      ['1', 'o/a', ['o/a']],
      ['2', 'o/a', ['o/a']],
      ['3', '', []],
      ['4', 'o/known', ['o/known']],
    ],
  )
  assert.equal(g.calls.filter((c) => c.cwd === '/w/a').length, 1, '同じ cwd は 1 回だけ')
  assert.equal(g.calls.some((c) => c.cwd === '/w/b'), false, '既に分かっているものは引かない')
  assert.deepEqual(await fillProjects(r, []), [], '空でも落ちない')
})

test('ProjectResolver: 本物のリポジトリ（bare clone の worktree と普通の clone）', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sai-proj-'))
  try {
    const src = join(dir, 'src')
    await run('mkdir', ['-p', src])
    await git(src, 'init', '-q', '-b', 'main')
    await git(src, 'commit', '-q', '--allow-empty', '-m', 'x')
    const bare = join(dir, 'myrepo.git')
    await run('git', ['clone', '-q', '--bare', src, bare])
    const wt = join(bare, 'dev-min')
    await git(bare, 'worktree', 'add', '-q', wt, 'main')

    const r = new ProjectResolver(new RealGit())
    // origin は clone 元のローカルパスなので normalizeRemote が空 → common-dir に落ちる
    assert.equal(await r.resolve(wt), 'myrepo', 'bare clone の worktree でもリポジトリ名')
    assert.equal(await r.resolve(src), 'src', '普通の clone は toplevel の名前')
    assert.equal(await r.resolve(join(dir, 'nope')), '', 'git が無いところは空')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('RealGit: remote は get-url だけ通す（add や set-url は弾く）', async () => {
  const g = new RealGit()
  await assert.rejects(g.run(process.cwd(), ['remote', 'add', 'x', 'https://example.com/x']), /読むだけ/)
  await assert.rejects(g.run(process.cwd(), ['remote', 'set-url', 'origin', 'https://example.com/x']), /読むだけ/)
  await assert.rejects(g.run(process.cwd(), ['remote', 'remove', 'origin']), /読むだけ/)
  // get-url は通る（origin があるリポジトリなので中身が返る）
  assert.match(await g.run(process.cwd(), ['remote', 'get-url', 'origin']), /\S/)
})
