import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { SKIPPED_MARK } from '../../shared/diff.ts'
import { clampPatch, NotAGitRepo, parseStats, RealGit, resolveBase, sessionDiff, sessionDiffSummary, validBase } from './diff.ts'
import type { Git } from './diff.ts'

const run = promisify(execFile)
/** テスト用のリポジトリ。名前とメールは環境に依らないよう固定する */
const git = async (cwd: string, ...args: string[]) => {
  await run('git', ['-C', cwd, '-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args])
}

/** 呼ばれた引数を覚え、決められた答えを返す */
class FakeGit implements Git {
  calls: string[][] = []
  answers = new Map<string, string>()
  fail = new Set<string>()
  async run(_cwd: string, args: string[]): Promise<string> {
    this.calls.push(args)
    const key = args.join(' ')
    if (this.fail.has(key)) throw new Error(`fake: ${key}`)
    return this.answers.get(key) ?? ''
  }
}

test('validBase: フラグに化けるものと空白入りは断る', () => {
  assert.equal(validBase('origin/main'), true)
  assert.equal(validBase('v1.2.3'), true)
  assert.equal(validBase(''), false)
  assert.equal(validBase('--output=/tmp/x'), false)
  assert.equal(validBase('-p'), false)
  assert.equal(validBase('a b'), false)
  assert.equal(validBase("a'b"), false)
})

test('resolveBase: origin/HEAD が未設定（bare clone）でも origin/main に落ちる', async () => {
  const g = new FakeGit()
  // bare clone だと symbolic-ref は失敗する
  g.fail.add('symbolic-ref -q --short refs/remotes/origin/HEAD')
  g.fail.add('rev-parse --verify --quiet origin/main^{commit}')
  g.fail.add('rev-parse --verify --quiet origin/master^{commit}')
  assert.equal(await resolveBase(g, '/w'), 'main', '無ければ次の候補へ')

  const g2 = new FakeGit()
  g2.fail.add('symbolic-ref -q --short refs/remotes/origin/HEAD')
  assert.equal(await resolveBase(g2, '/w'), 'origin/main', '最初に見つかったもの')

  const g3 = new FakeGit()
  g3.answers.set('symbolic-ref -q --short refs/remotes/origin/HEAD', 'origin/trunk\n')
  assert.equal(await resolveBase(g3, '/w'), 'origin/trunk', 'origin/HEAD があればそれ')

  const g4 = new FakeGit()
  g4.fail.add('symbolic-ref -q --short refs/remotes/origin/HEAD')
  for (const r of ['origin/main', 'origin/master', 'main', 'master']) g4.fail.add(`rev-parse --verify --quiet ${r}^{commit}`)
  assert.equal(await resolveBase(g4, '/w'), '', '1つも無ければ空')
})

test('resolveBase: ?base= は形と存在を見てから使う', async () => {
  const g = new FakeGit()
  assert.equal(await resolveBase(g, '/w', 'v1.0'), 'v1.0')
  assert.equal(await resolveBase(g, '/w', '--upload-pack=x'), '', 'フラグに化けるものは使わない')
  assert.equal(g.calls.some((c) => c.join(' ').includes('--upload-pack')), false, 'git にも渡さない')
  const missing = new FakeGit()
  missing.fail.add('rev-parse --verify --quiet nope^{commit}')
  assert.equal(await resolveBase(missing, '/w', 'nope'), '', '無いものは使わない')
})

// ---- #289: origin/<x> と <x> が両方あれば新しい方

/** origin/HEAD が未設定（bare clone）で、origin/main も main も有る */
function bothExist(): FakeGit {
  const g = new FakeGit()
  g.fail.add('symbolic-ref -q --short refs/remotes/origin/HEAD')
  return g
}

test('resolveBase: origin/main が置き去りで main の祖先なら main（bare clone + worktree の形。#289）', async () => {
  const g = bothExist()
  g.fail.add('merge-base --is-ancestor main origin/main')
  assert.equal(await resolveBase(g, '/w'), 'main')
})

test('resolveBase: main が origin/main の祖先（普通の clone で main が古い）なら origin/main', async () => {
  const g = bothExist()
  g.fail.add('merge-base --is-ancestor origin/main main')
  assert.equal(await resolveBase(g, '/w'), 'origin/main')
})

test('resolveBase: 同じコミット・分岐しているときは今までどおり origin/main', async () => {
  assert.equal(await resolveBase(bothExist(), '/w'), 'origin/main', '同じコミット（どちら向きにも祖先）')
  const diverged = bothExist()
  diverged.fail.add('merge-base --is-ancestor main origin/main')
  diverged.fail.add('merge-base --is-ancestor origin/main main')
  assert.equal(await resolveBase(diverged, '/w'), 'origin/main', '分岐')
})

test('resolveBase: 片方しか無ければ比べない。origin/HEAD の先にも同じ規則、?base= には当てない', async () => {
  const onlyRemote = bothExist()
  onlyRemote.fail.add('rev-parse --verify --quiet main^{commit}')
  assert.equal(await resolveBase(onlyRemote, '/w'), 'origin/main')
  assert.equal(onlyRemote.calls.some((c) => c[0] === 'merge-base'), false, 'ローカルが無ければ merge-base も呼ばない')

  const head = new FakeGit()
  head.answers.set('symbolic-ref -q --short refs/remotes/origin/HEAD', 'origin/trunk\n')
  head.fail.add('merge-base --is-ancestor trunk origin/trunk')
  assert.equal(await resolveBase(head, '/w'), 'trunk', 'origin/HEAD が指す origin/trunk より trunk が新しい')

  const pinned = bothExist()
  pinned.fail.add('merge-base --is-ancestor main origin/main')
  assert.equal(await resolveBase(pinned, '/w', 'origin/main'), 'origin/main', '明示された base はそのまま')
})

test('sessionDiff / sessionDiffSummary: 置き去りの origin/main ではなく main と比べ、他の PR を混ぜない（#289）', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sai-stalebase-'))
  const commit = async (file: string, body: string, message: string) => {
    await writeFile(join(dir, file), body)
    await git(dir, 'add', '.')
    await git(dir, 'commit', '-q', '-m', message)
  }
  try {
    await git(dir, 'init', '-q', '-b', 'main')
    await commit('a.ts', 'one\n', 'first')
    // ここで origin/main が一度作られ、そのまま進まない（refspec の無い bare clone と同じ）
    await git(dir, 'update-ref', 'refs/remotes/origin/main', 'HEAD')
    // その後に main へ入った他の PR が 2 本
    await commit('other1.ts', 'x\n', 'pr 1')
    await commit('other2.ts', 'y\n', 'pr 2')
    const g = new RealGit()

    const onMain = await sessionDiff(g, dir)
    assert.equal(onMain.base, 'main')
    assert.deepEqual(onMain.branch.files, [], 'main にいる worktree のブランチの差分は無い')

    await git(dir, 'checkout', '-q', '-b', 'feat/x')
    await commit('mine.ts', 'mine\n', 'work')
    const d = await sessionDiff(g, dir)
    assert.equal(d.base, 'main')
    assert.deepEqual(d.branch.files.map((f) => f.path), ['mine.ts'], '後から main に入った other1 / other2 は混ざらない')
    const s = await sessionDiffSummary(g, dir)
    assert.equal(s.base, 'main', '要約（差分ボタンの行数）も同じ相手と比べる')
    assert.deepEqual(s.branch, { files: 1, added: 1, removed: 0 })
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('sessionDiff: 普通の clone の形（origin/main が新しく main が古い）では origin/main と比べる', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sai-freshorigin-'))
  const commit = async (file: string, body: string, message: string) => {
    await writeFile(join(dir, file), body)
    await git(dir, 'add', '.')
    await git(dir, 'commit', '-q', '-m', message)
  }
  try {
    await git(dir, 'init', '-q', '-b', 'main')
    await commit('a.ts', 'one\n', 'first')
    // origin では main が 1 本進んでいる（fetch 済み）。ローカルの main は pull していないので古いまま
    await git(dir, 'checkout', '-q', '-b', 'upstream')
    await commit('other.ts', 'x\n', 'pr on origin')
    await git(dir, 'update-ref', 'refs/remotes/origin/main', 'HEAD')
    // 作業ブランチは origin/main から切る
    await git(dir, 'checkout', '-q', '-b', 'feat/y')
    await commit('mine.ts', 'mine\n', 'work')

    const d = await sessionDiff(new RealGit(), dir)
    assert.equal(d.base, 'origin/main')
    assert.deepEqual(d.branch.files.map((f) => f.path), ['mine.ts'], '古い main と比べると other.ts まで混ざる')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('parseStats: numstat と name-status を突き合わせる。バイナリとリネーム', () => {
  const numstat = ['3\t1\tserver/app.ts', '-\t-\tweb/logo.png', '0\t0\told.ts => new.ts', '5\t0\tnew-file.ts'].join('\n')
  const nameStatus = ['M\tserver/app.ts', 'M\tweb/logo.png', 'R100\told.ts\tnew.ts', 'A\tnew-file.ts'].join('\n')
  assert.deepEqual(parseStats(numstat, nameStatus), [
    { path: 'server/app.ts', old_path: undefined, status: 'modified', added: 3, removed: 1 },
    { path: 'web/logo.png', old_path: undefined, status: 'binary', added: 0, removed: 0 },
    { path: 'new.ts', old_path: 'old.ts', status: 'renamed', added: 0, removed: 0 },
    { path: 'new-file.ts', old_path: undefined, status: 'added', added: 5, removed: 0 },
  ])
  assert.deepEqual(parseStats('', ''), [])
})

test('clampPatch: 上限を超えたら大きいファイルの本文を落とし、全体でも打ち切る', () => {
  const file = (name: string, body: string) => `diff --git a/${name} b/${name}\n--- a/${name}\n+++ b/${name}\n@@ -1 +1 @@\n+${body}`
  const small = file('a.ts', 'x')
  assert.deepEqual(clampPatch(small, 1000, 1000), { patch: small, truncated: false }, '収まればそのまま')

  // 1 ファイルが大きすぎる → 見出しだけ残して印を付ける
  const big = file('big.json', 'y'.repeat(500))
  const one = clampPatch(`${small}\n${big}`, 100_000, 200)
  assert.equal(one.truncated, true)
  assert.ok(one.patch.includes(SKIPPED_MARK))
  assert.ok(one.patch.includes('diff --git a/big.json b/big.json'), '見出しは残る')
  assert.ok(!one.patch.includes('y'.repeat(500)), '本文は落ちる')
  assert.ok(one.patch.includes(small), '小さいファイルはそのまま')

  // 全体が上限を超える → そこで打ち切る
  const many = [file('a.ts', 'a'), file('b.ts', 'b'), file('c.ts', 'c')].join('\n')
  const cut = clampPatch(many, 120, 200)
  assert.equal(cut.truncated, true)
  assert.ok(cut.patch.length <= 120)
})

test('RealGit: 読むだけのコマンドしか通さない', async () => {
  const g = new RealGit()
  await assert.rejects(g.run(process.cwd(), ['checkout', 'main']), /読むだけ/)
  await assert.rejects(g.run(process.cwd(), ['stash']), /読むだけ/)
  await assert.rejects(g.run(process.cwd(), ['-c', 'x=y', 'commit', '-m', 'x']), /読むだけ/)
  assert.match(await g.run(process.cwd(), ['rev-parse', '--git-dir']), /\S/)
})

test('sessionDiff: 本物のリポジトリで、ブランチの差分と未コミットを読む', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sai-diff-'))
  try {
    await git(dir, 'init', '-q', '-b', 'main')
    await writeFile(join(dir, 'a.ts'), 'one\ntwo\nthree\n')
    await git(dir, 'add', '.')
    await git(dir, 'commit', '-q', '-m', 'first')
    // 作業用のブランチで 1 コミット（= PR で見るぶん）
    await git(dir, 'checkout', '-q', '-b', 'feat/x')
    await writeFile(join(dir, 'a.ts'), 'one\nTWO\nthree\n')
    await writeFile(join(dir, 'b.ts'), 'new file\n')
    await git(dir, 'add', '.')
    await git(dir, 'commit', '-q', '-m', 'work')
    // まだコミットしていない書き換えと、追跡外のファイル
    await writeFile(join(dir, 'a.ts'), 'one\nTWO\nTHREE\n')
    await writeFile(join(dir, 'untracked.ts'), 'not added\n')

    const g = new RealGit()
    const d = await sessionDiff(g, dir)
    assert.equal(d.base, 'main', 'origin が無いのでローカルの main に落ちる')
    assert.equal(d.head, 'feat/x')

    assert.deepEqual(
      d.branch.files.map((f) => [f.path, f.status, f.added, f.removed]),
      [
        ['a.ts', 'modified', 1, 1],
        ['b.ts', 'added', 1, 0],
      ],
      'ブランチの差分は main からの 2 ファイル（未コミットは混ざらない）',
    )
    assert.ok(d.branch.patch.includes('+TWO'))
    assert.equal(d.branch.truncated, false)

    assert.deepEqual(
      d.working.files.map((f) => [f.path, f.added, f.removed]),
      [['a.ts', 1, 1]],
      '未コミットは HEAD からの差分だけ',
    )
    assert.ok(d.working.patch.includes('+THREE'))
    assert.deepEqual(d.untracked, ['untracked.ts'], '追跡外は名前だけ')

    // base を明示すると、その相手と比べる
    const pinned = await sessionDiff(g, dir, 'HEAD')
    assert.equal(pinned.base, 'HEAD')
    assert.deepEqual(pinned.branch.files, [], 'HEAD と HEAD の差は無い')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('sessionDiffSummary: 行数だけを返し、patch は作らない（#211）', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sai-diffsum-'))
  try {
    await git(dir, 'init', '-q', '-b', 'main')
    await writeFile(join(dir, 'a.ts'), 'one\ntwo\nthree\n')
    await git(dir, 'add', '.')
    await git(dir, 'commit', '-q', '-m', 'first')
    await git(dir, 'checkout', '-q', '-b', 'feat/x')
    await writeFile(join(dir, 'a.ts'), 'one\nTWO\nthree\n')
    await writeFile(join(dir, 'b.ts'), 'new file\n')
    await git(dir, 'add', '.')
    await git(dir, 'commit', '-q', '-m', 'work')
    // 未コミット。a.ts はブランチの差分にも出るので、files は重複を畳んで 2 になる
    await writeFile(join(dir, 'a.ts'), 'one\nTWO\nTHREE\n')
    await writeFile(join(dir, 'untracked.ts'), 'not added\n')

    const s = await sessionDiffSummary(new RealGit(), dir)
    assert.equal(s.base, 'main')
    assert.equal(s.head, 'feat/x')
    assert.equal(s.head_branch, 'feat/x', 'detached でなければブランチ名が入る')
    assert.deepEqual(s.branch, { files: 2, added: 2, removed: 1 }, 'ブランチの差分は a.ts(+1-1) と b.ts(+1)')
    assert.deepEqual(s.working, { files: 1, added: 1, removed: 1 }, '未コミットは a.ts だけ')
    assert.equal(s.files, 2, 'a.ts が両方に出るので 2 ファイル（3 ではない）')
    assert.equal(s.added, 3)
    assert.equal(s.removed, 2)
    assert.equal(s.untracked, 1)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('sessionDiffSummary: 呼ぶ git は numstat だけで、本文（diff 単体）は取らない', async () => {
  const g = new FakeGit()
  g.answers.set('symbolic-ref -q --short HEAD', 'feat/x\n')
  g.answers.set('rev-parse --verify --quiet main^{commit}', 'sha\n')
  g.fail.add('symbolic-ref -q --short refs/remotes/origin/HEAD')
  g.fail.add('rev-parse --verify --quiet origin/main^{commit}')
  g.fail.add('rev-parse --verify --quiet origin/master^{commit}')
  await sessionDiffSummary(g, '/tmp/x')
  const diffs = g.calls.filter((a) => a[0] === 'diff')
  assert.ok(diffs.length > 0, 'diff は呼ぶ')
  assert.ok(
    diffs.every((a) => a.includes('--numstat')),
    `本文を作る素の diff は呼ばない: ${JSON.stringify(diffs)}`,
  )
  assert.ok(!g.calls.some((a) => a.includes('--name-status')), 'status は使わないので name-status も呼ばない')
})

test('sessionDiffSummary: detached HEAD では head_branch が空（PR を引かせない）', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sai-detach-'))
  try {
    await git(dir, 'init', '-q', '-b', 'main')
    await writeFile(join(dir, 'a.ts'), 'one\n')
    await git(dir, 'add', '.')
    await git(dir, 'commit', '-q', '-m', 'first')
    await git(dir, 'checkout', '-q', '--detach', 'HEAD')
    const s = await sessionDiffSummary(new RealGit(), dir)
    assert.equal(s.head_branch, '', 'detached ではブランチ名を返さない')
    assert.match(s.head, /^[0-9a-f]{4,}$/, 'head は短い SHA')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('sessionDiff: git のリポジトリでなければ NotAGitRepo', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sai-nodiff-'))
  try {
    await assert.rejects(sessionDiff(new RealGit(), dir), NotAGitRepo)
    await assert.rejects(sessionDiff(new RealGit(), ''), NotAGitRepo)
    // 要約の側も同じ扱い（画面は 404 を見てボタンを出さない）
    await assert.rejects(sessionDiffSummary(new RealGit(), dir), NotAGitRepo)
    await assert.rejects(sessionDiffSummary(new RealGit(), ''), NotAGitRepo)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
