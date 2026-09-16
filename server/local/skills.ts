// 返信の入力欄の `/` の候補になるスキル。`~/.claude/skills/<name>/SKILL.md`（ユーザー）と
// `<セッションの cwd>/.claude/skills/`（プロジェクト）を読む。読み方は shared/skills.ts。
//
// **Codex は置き場が違う**（#402。v0.154.0 で実測）: リポジトリ側は `<cwd>/.codex/skills/` と `<cwd>/.agents/skills/` で、
// **`.claude/skills/` は読まない**（Claude 用の置き場を Codex の候補に混ぜると、選んでも展開されないものが並ぶ）。
// cwd に依らない分（`$CODEX_HOME/skills/`・プラグイン・組み込み）はここでは読まず、app-server の `skills/list` から取る
// （プラグインのスキルは `~/.codex/plugins/cache/<namespace>/<plugin>/<version>/skills/` にあって名前も `<plugin>:<skill>` に
// なるので、置き場を真似して読むと Codex 側の見つけ方を二重に実装することになる）。
//
// ディレクトリの mtime で覚えて、変わらなければ読み直さない。スキルが増えた・減ったときは mtime が変わるので拾えるが、
// 既にある SKILL.md の説明だけを書き換えたときは変わらない（候補の説明が古いままになるだけなので許容する）。
import { readdir, readFile, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { parseSkill, type Skill } from '../../shared/skills.ts'

export const SKILL_FILE = 'SKILL.md'
/** Claude のプロジェクト側の置き場（セッションの cwd からの相対） */
export const PROJECT_SKILLS_DIR = join('.claude', 'skills')
/** Codex のリポジトリ側の置き場。前が勝つ（同じ名前なら `.codex/skills/`） */
export const CODEX_PROJECT_SKILLS_DIRS = [join('.codex', 'skills'), join('.agents', 'skills')]

/** そのセッションの cwd から読む置き場。Claude と Codex で違う */
export type SkillAgent = 'claude' | 'codex'

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

  /**
   * そのセッションで使えるスキル。プロジェクト側を先に並べ、同じ名前はプロジェクトが勝つ。
   * Codex はリポジトリ側の置き場だけ（cwd に依らない分は app-server の `skills/list` から。`app.ts` が足す）
   */
  async forCwd(cwd: string, agent: SkillAgent = 'claude'): Promise<Skill[]> {
    if (agent === 'codex') return cwd ? await this.project(cwd, CODEX_PROJECT_SKILLS_DIRS) : []
    const project = cwd ? await this.project(cwd, [PROJECT_SKILLS_DIR]) : []
    const user = await this.read(this.userDir, 'user')
    const seen = new Set(project.map((s) => s.name))
    return [...project, ...user.filter((s) => !seen.has(s.name))]
  }

  /** cwd の下の置き場を順に読んで繋ぐ。同じ名前なら先の置き場が勝つ */
  private async project(cwd: string, dirs: readonly string[]): Promise<Skill[]> {
    const out: Skill[] = []
    const seen = new Set<string>()
    for (const dir of dirs) {
      for (const skill of await this.read(join(cwd, dir), 'project')) {
        if (seen.has(skill.name)) continue
        seen.add(skill.name)
        out.push(skill)
      }
    }
    return out
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
