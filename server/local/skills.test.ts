import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Git } from '../git/diff.ts'
import { CODEX_PROJECT_SKILLS_DIRS, PROJECT_SKILLS_DIR, SkillStore, skillPlaces, userSkillsDir } from './skills.ts'

let dir: string
let userDir: string
let cwd: string

const put = async (root: string, name: string, description: string) => {
  await mkdir(join(root, name), { recursive: true })
  await writeFile(join(root, name, 'SKILL.md'), `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n`)
}

before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'sai-skills-'))
  userDir = join(dir, 'home', '.claude', 'skills')
  cwd = join(dir, 'work')
  await put(userDir, 'issue-triage', 'issueの優先度をつけて')
  await put(userDir, 'start-issue', '着手する前に確かめる')
  await put(userDir, 'sync-main', 'ユーザー側の同名')
  await put(join(cwd, PROJECT_SKILLS_DIR), 'sync-main', 'main worktree を最新にする')
  // Codex の置き場（#402）。`.codex/skills/` と `.agents/skills/` の両方
  await put(join(cwd, CODEX_PROJECT_SKILLS_DIRS[0]!), 'codex-only', '.codex/skills の分')
  await put(join(cwd, CODEX_PROJECT_SKILLS_DIRS[0]!), 'both', '.codex/skills の同名')
  await put(join(cwd, CODEX_PROJECT_SKILLS_DIRS[1]!), 'both', '.agents/skills の同名')
  await put(join(cwd, CODEX_PROJECT_SKILLS_DIRS[1]!), 'agents-only', '.agents/skills の分')
  // SKILL.md が無いディレクトリと隠しディレクトリは飛ばす
  await mkdir(join(userDir, 'not-a-skill'), { recursive: true })
  await mkdir(join(userDir, '.hidden'), { recursive: true })
})

after(async () => {
  await rm(dir, { recursive: true, force: true })
})

test('userSkillsDir は ~/.claude/skills', () => {
  assert.equal(userSkillsDir('/home/me'), join('/home/me', '.claude', 'skills'))
})

test('forCwd はプロジェクトを先に並べ、同じ名前はプロジェクトが勝つ', async () => {
  const skills = await new SkillStore(userDir).forCwd(cwd)
  assert.deepEqual(
    skills.map((s) => [s.name, s.source]),
    [
      ['sync-main', 'project'],
      ['issue-triage', 'user'],
      ['start-issue', 'user'],
    ],
  )
  assert.equal(skills[0]?.description, 'main worktree を最新にする', 'プロジェクト側の説明')
})

test('プロジェクト側が無ければユーザーの分だけ。cwd が空でも落ちない', async () => {
  const store = new SkillStore(userDir)
  assert.deepEqual((await store.forCwd(join(dir, 'nowhere'))).map((s) => s.name), ['issue-triage', 'start-issue', 'sync-main'])
  assert.deepEqual((await store.forCwd('')).map((s) => s.name), ['issue-triage', 'start-issue', 'sync-main'])
})

test('ユーザーのディレクトリが無ければ空。スキルを足すと拾い直す', async () => {
  const empty = new SkillStore(join(dir, 'no-home'))
  assert.deepEqual(await empty.forCwd(''), [])

  const store = new SkillStore(userDir)
  assert.equal((await store.forCwd('')).length, 3)
  await put(userDir, 'pr-status', 'PR の状態')
  assert.equal((await store.forCwd('')).length, 4, 'ディレクトリの mtime が変わるので読み直す')
})

test('Codex は .codex/skills と .agents/skills だけを読む（.claude/skills もユーザー側も見ない）', async () => {
  const store = new SkillStore(userDir)
  const skills = await store.forCwd(cwd, 'codex')
  assert.deepEqual(
    skills.map((s) => [s.name, s.source]),
    [
      ['both', 'project'],
      ['codex-only', 'project'],
      ['agents-only', 'project'],
    ],
    '.codex/skills が先で、同じ名前はそちらが勝つ',
  )
  assert.equal(skills.find((s) => s.name === 'both')?.description, '.codex/skills の同名')
  assert.equal(skills.some((s) => s.name === 'sync-main'), false, 'Codex は .claude/skills を読まない')
  assert.equal(skills.some((s) => s.name === 'issue-triage'), false, 'cwd に依らない分は app-server から取るのでここでは出さない')
  assert.deepEqual(await store.forCwd('', 'codex'), [], 'cwd が空なら空')
  assert.deepEqual(await store.forCwd(join(dir, 'nowhere'), 'codex'), [], '置き場が無ければ空')
})

// #885: 作業ディレクトリが worktree の一番上より下でも、一番上までの置き場を読む
/** `rev-parse --show-toplevel` にだけ答える偽の git。ほかは断る。聞かれた形を覚える */
const fakeGit = (top: string | Error) => {
  const asked: string[][] = []
  const git: Git = {
    run: async (_cwd, args) => {
      asked.push(args)
      if (args.join(' ') !== 'rev-parse --show-toplevel') throw new Error(`知らない形: ${args.join(' ')}`)
      if (top instanceof Error) throw top
      return `${top}\n`
    },
  }
  return { git, asked }
}

test('上へ辿る: 作業ディレクトリから一番上まで途中も読み、近いほうが勝つ。一番上より上は読まない', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'sai-skills-walk-')))
  try {
    const top = join(root, 'tree')
    const deep = join(top, 'pkg', 'src')
    await mkdir(deep, { recursive: true })
    await put(join(root, PROJECT_SKILLS_DIR), 'above-top', '一番上より上')
    await put(join(top, PROJECT_SKILLS_DIR), 'at-top', '一番上')
    await put(join(top, PROJECT_SKILLS_DIR), 'same-name', '一番上の同名')
    await put(join(top, 'pkg', PROJECT_SKILLS_DIR), 'at-middle', '途中')
    await put(join(deep, PROJECT_SKILLS_DIR), 'same-name', '作業ディレクトリの同名')
    await put(join(top, CODEX_PROJECT_SKILLS_DIRS[0]!), 'codex-top', '.codex の一番上')
    await put(join(top, 'pkg', CODEX_PROJECT_SKILLS_DIRS[1]!), 'codex-middle', '.agents の途中')
    await put(join(root, CODEX_PROJECT_SKILLS_DIRS[1]!), 'codex-above', '一番上より上')
    const { git, asked } = fakeGit(top)
    const store = new SkillStore(join(root, 'no-home'))

    const claude = await store.forCwd(deep, 'claude', git)
    assert.deepEqual(claude.map((s) => s.name), ['same-name', 'at-middle', 'at-top'], '近い順。一番上より上は出さない')
    assert.equal(claude[0]?.description, '作業ディレクトリの同名', '同じ名前は作業ディレクトリに近いほうが勝つ')
    assert.ok(claude.every((s) => s.source === 'project'))

    const codex = await store.forCwd(deep, 'codex', git)
    assert.deepEqual(codex.map((s) => s.name), ['codex-middle', 'codex-top'], 'Codex も同じ範囲（.claude/skills は読まない）')

    assert.deepEqual(asked, [['rev-parse', '--show-toplevel'], ['rev-parse', '--show-toplevel']], 'git は読むだけの 1 形だけ')

    await put(join(top, PROJECT_SKILLS_DIR), 'added-later', '後から足した')
    assert.ok((await store.forCwd(deep, 'claude', git)).some((s) => s.name === 'added-later'), '辿った各ディレクトリの mtime で拾い直す')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('上へ辿る: 一番上が引けない・cwd が一番上の外・git を渡さないときは cwd だけ', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'sai-skills-walk-')))
  try {
    const top = join(root, 'tree')
    const deep = join(top, 'pkg')
    await mkdir(deep, { recursive: true })
    await put(join(top, PROJECT_SKILLS_DIR), 'at-top', '一番上')
    await put(join(deep, PROJECT_SKILLS_DIR), 'here', '作業ディレクトリ')
    const store = new SkillStore(join(root, 'no-home'))
    const names = async (git?: Git) => (await store.forCwd(deep, 'claude', git)).map((s) => s.name)

    assert.deepEqual(await names(fakeGit(new Error('not a git repository')).git), ['here'], 'git が読めなければ cwd だけ')
    assert.deepEqual(await names(fakeGit(join(root, 'other')).git), ['here'], '一番上が実在しなければ cwd だけ')
    await mkdir(join(root, 'elsewhere'))
    assert.deepEqual(await names(fakeGit(join(root, 'elsewhere')).git), ['here'], 'cwd が一番上の外なら cwd だけ')
    assert.deepEqual(await names(), ['here'], 'git を渡さなければ cwd だけ')
    assert.deepEqual(await skillPlaces(top, fakeGit(top).git), [top], 'cwd が一番上ならそこだけ')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
