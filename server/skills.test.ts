import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PROJECT_SKILLS_DIR, SkillStore, userSkillsDir } from './skills.ts'

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
