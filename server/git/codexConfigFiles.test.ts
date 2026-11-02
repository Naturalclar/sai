// 差分の画面の、サブディレクトリの `.codex/`（#856）
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { subdirCodexFiles } from './codexConfigFiles.ts'
import { RealGit } from './diff.ts'
import type { Git } from './diff.ts'

test('追跡しているもの・追跡外・.gitignore 済みを分けて返し、一番上の .codex は出さない', async () => {
  const asked: { cwd: string; args: string[] }[] = []
  const git: Git = {
    async run(cwd, args) {
      asked.push({ cwd, args })
      if (args[0] === 'rev-parse') return '/w/tree\n'
      if (args.includes('--ignored')) return 'b/.codex/rules/x\0'
      if (args.includes('--others')) return '.codex/top\0a/.codex/config.toml\0'
      return 'c/.codex/config.toml\0'
    },
  }
  assert.deepEqual(await subdirCodexFiles(git, '/w/tree/sub'), [
    { path: 'a/.codex/config.toml', state: 'untracked' },
    { path: 'b/.codex/rules/x', state: 'ignored' },
    { path: 'c/.codex/config.toml', state: 'tracked' },
  ])
  assert.ok(asked.filter((a) => a.args[0] === 'ls-files').every((a) => a.cwd === '/w/tree'), 'worktree 全体を見る')
})

test('git が読めなければ投げる（画面は「読めない」と出す）', async () => {
  await assert.rejects(subdirCodexFiles({ run: () => Promise.reject(new Error('fatal')) }, '/w'))
})

let dir: string
before(async () => {
  dir = await realpath(await mkdtemp(join(tmpdir(), 'sai-codex-files-')))
})
after(async () => {
  await rm(dir, { recursive: true, force: true })
})

test('作り物のリポジトリで: 3 つとも拾い、関係ないファイルは拾わない', async () => {
  const run = (...args: string[]) => execFileSync('git', ['-C', dir, ...args], { stdio: 'ignore' })
  run('init', '-q')
  for (const d of ['tracked/.codex', 'open/.codex', 'hidden/.codex', '.codex', 'plain']) await mkdir(join(dir, d), { recursive: true })
  await writeFile(join(dir, '.gitignore'), 'hidden/\n')
  await writeFile(join(dir, 'tracked/.codex/config.toml'), 'x')
  await writeFile(join(dir, 'open/.codex/config.toml'), 'x')
  await writeFile(join(dir, 'hidden/.codex/rules'), 'x')
  await writeFile(join(dir, '.codex/config.toml'), 'x')
  await writeFile(join(dir, 'plain/file'), 'x')
  run('add', 'tracked')
  assert.deepEqual(await subdirCodexFiles(new RealGit(), join(dir, 'plain')), [
    { path: 'hidden/.codex/rules', state: 'ignored' },
    { path: 'open/.codex/config.toml', state: 'untracked' },
    { path: 'tracked/.codex/config.toml', state: 'tracked' },
  ])
})
