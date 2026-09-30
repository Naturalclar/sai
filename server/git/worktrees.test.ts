import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RealGit } from './diff.ts'
import { insideTree, parseWorktreeList, treeOf, worktreeKey, Worktrees } from './worktrees.ts'

test('parseWorktreeList: bare / branch / detached / locked / prunable を読む（#319）', () => {
  const out = [
    'worktree /r/sai.git',
    'bare',
    '',
    'worktree /r/sai.git/dev-min',
    'HEAD 690d8db',
    'branch refs/heads/issue-319',
    '',
    'worktree /tmp/pr454-wt',
    'HEAD 1e7f2c0',
    'detached',
    'prunable gitdir file points to non-existent location',
    '',
    'worktree /r/sai.git/dev-lock',
    'HEAD 1e7f2c0',
    'branch refs/heads/feat/a',
    'locked reason with spaces',
    '',
  ].join('\n')
  assert.deepEqual(parseWorktreeList(out), [
    { path: '/r/sai.git', branch: '', bare: true, prunable: false, locked: false },
    { path: '/r/sai.git/dev-min', branch: 'issue-319', bare: false, prunable: false, locked: false },
    { path: '/tmp/pr454-wt', branch: '', bare: false, prunable: true, locked: false },
    { path: '/r/sai.git/dev-lock', branch: 'feat/a', bare: false, prunable: false, locked: true },
  ])
})

test('insideTree / treeOf: 同じか下のディレクトリだけ。名前の前方一致（dev-min と dev-minx）には当てない。入れ子は深い方', () => {
  assert.equal(insideTree('/r/sai.git/dev-min', '/r/sai.git/dev-min'), true)
  assert.equal(insideTree('/r/sai.git/dev-min/web', '/r/sai.git/dev-min'), true)
  assert.equal(insideTree('/r/sai.git/dev-minx', '/r/sai.git/dev-min'), false)
  assert.equal(insideTree('/r/sai.git', '/r/sai.git/dev-min'), false, 'bare 本体は作業ツリーの中ではない')
  const trees = [
    { path: '/r/app', key: worktreeKey('/r/app'), branch: 'main' },
    { path: '/r/app/.claude/worktrees/x', key: worktreeKey('/r/app/.claude/worktrees/x'), branch: 'x' },
  ]
  assert.equal(treeOf('/r/app/.claude/worktrees/x/src', trees)?.branch, 'x')
  assert.equal(treeOf('/r/app/src', trees)?.branch, 'main')
  assert.equal(treeOf('/tmp', trees), null)
})

let dir: string
let bare: string
const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { stdio: 'pipe' }).toString()

before(async () => {
  dir = await realpath(await mkdtemp(join(tmpdir(), 'sai-wt-')))
  // bare clone + worktree の形（このリポジトリの置き方）
  const seed = join(dir, 'seed')
  await mkdir(seed)
  git(seed, 'init', '-q', '-b', 'main')
  git(seed, '-c', 'user.email=a@b', '-c', 'user.name=a', 'commit', '-q', '--allow-empty', '-m', 'init')
  bare = join(dir, 'app.git')
  execFileSync('git', ['clone', '-q', '--bare', seed, bare])
  git(bare, 'worktree', 'add', '-q', join(bare, 'dev-a'), '-b', 'dev-a')
  git(bare, 'worktree', 'add', '-q', join(bare, 'dev-b'), '-b', 'dev-b')
  git(bare, 'worktree', 'add', '-q', join(bare, 'dev-lock'), '-b', 'dev-lock')
  git(bare, 'worktree', 'lock', join(bare, 'dev-lock'))
  git(bare, 'worktree', 'add', '-q', join(bare, 'gone'), '-b', 'gone')
  await rm(join(bare, 'gone'), { recursive: true })
})

after(async () => {
  await rm(dir, { recursive: true, force: true })
})

test('Worktrees.usable: bare clone の中の worktree から、兄弟が全部出る。bare 本体と消えたもの（prunable）は出さない。lock は出す', async () => {
  const trees = await new Worktrees(new RealGit()).usable(join(bare, 'dev-a'))
  assert.deepEqual(trees?.map((t) => [t.path, t.branch]), [
    [join(bare, 'dev-a'), 'dev-a'],
    [join(bare, 'dev-b'), 'dev-b'],
    [join(bare, 'dev-lock'), 'dev-lock'],
  ])
  assert.equal(trees?.[1]?.key, worktreeKey(join(bare, 'dev-b')))
  // bare 本体から読んでも同じ顔ぶれ（ただし bare 本体は作業ツリーの中ではない）
  const fromBare = await new Worktrees(new RealGit()).usable(bare)
  assert.equal(fromBare?.length, 3)
  assert.equal(treeOf(bare, fromBare!), null)
})

test('Worktrees.usable: git の外は null。覚えた一覧は fresh で読み直す', async () => {
  assert.equal(await new Worktrees(new RealGit()).usable(dir), null)
  let calls = 0
  const counting = { run: async () => (calls++, `worktree ${join(bare, 'dev-a')}\nbranch refs/heads/dev-a\n`) }
  const w = new Worktrees(counting)
  await w.usable('/x')
  await w.usable('/x')
  assert.equal(calls, 1, '30 秒は覚える')
  await w.usable('/x', true)
  assert.equal(calls, 2, '始めるときは読み直す')
})

test('RealGit: worktree は list だけ通し、add / remove / prune は弾く（読むだけ）', async () => {
  const real = new RealGit()
  for (const verb of ['add', 'remove', 'prune', 'move', 'lock']) {
    await assert.rejects(real.run(join(bare, 'dev-a'), ['worktree', verb, join(dir, 'x')]), /読むだけ/, verb)
  }
})
