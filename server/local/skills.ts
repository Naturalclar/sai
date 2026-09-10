// 返信の入力欄の `/` の候補になるスキル。`~/.claude/skills/<name>/SKILL.md`（ユーザー）と
// `<セッションの cwd>/.claude/skills/`（プロジェクト）を読む。読み方は shared/skills.ts。
//
// ディレクトリの mtime で覚えて、変わらなければ読み直さない。スキルが増えた・減ったときは mtime が変わるので拾えるが、
// 既にある SKILL.md の説明だけを書き換えたときは変わらない（候補の説明が古いままになるだけなので許容する）。
import { readdir, readFile, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { parseSkill, type Skill } from '../../shared/skills.ts'

export const SKILL_FILE = 'SKILL.md'
/** プロジェクト側の置き場（セッションの cwd からの相対） */
export const PROJECT_SKILLS_DIR = join('.claude', 'skills')

export const userSkillsDir = (home: string = homedir()): string => join(home, '.claude', 'skills')

interface Cached {
  mtimeMs: number
  skills: Skill[]
}

export class SkillStore {
  readonly userDir: string
  private cache = new Map<string, Cached>()

  constructor(userDir: string = userSkillsDir()) {
    this.userDir = userDir
  }

  /** そのセッションで使えるスキル。プロジェクト側を先に並べ、同じ名前はプロジェクトが勝つ */
  async forCwd(cwd: string): Promise<Skill[]> {
    const project = cwd ? await this.read(join(cwd, PROJECT_SKILLS_DIR), 'project') : []
    const user = await this.read(this.userDir, 'user')
    const seen = new Set(project.map((s) => s.name))
    return [...project, ...user.filter((s) => !seen.has(s.name))]
  }

  private async read(dir: string, source: Skill['source']): Promise<Skill[]> {
    let st
    try {
      st = await stat(dir)
    } catch {
      this.cache.delete(dir)
      return []
    }
    const hit = this.cache.get(dir)
    if (hit && hit.mtimeMs === st.mtimeMs) return hit.skills
    let names: string[] = []
    try {
      names = await readdir(dir)
    } catch {
      names = []
    }
    const skills: Skill[] = []
    for (const name of names.sort()) {
      if (name.startsWith('.')) continue
      let text: string
      try {
        text = await readFile(join(dir, name, SKILL_FILE), 'utf-8')
      } catch {
        continue // SKILL.md が無いディレクトリは飛ばす
      }
      const skill = parseSkill(text, name, source)
      if (skill) skills.push(skill)
    }
    this.cache.set(dir, { mtimeMs: st.mtimeMs, skills })
    return skills
  }
}
