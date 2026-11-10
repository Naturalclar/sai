// 返信の入力欄の `/` の候補になるスキル。`~/.claude/skills/<name>/SKILL.md`（ユーザー）と
// `<セッションの cwd>/.claude/skills/`（プロジェクト）を読む。読み方は shared/skills.ts。
//
// **Codex は置き場が違う**（#402。v0.154.0 で実測）: リポジトリ側は `<cwd>/.codex/skills/` と `<cwd>/.agents/skills/` で、
// **`.claude/skills/` は読まない**（Claude 用の置き場を Codex の候補に混ぜると、選んでも展開されないものが並ぶ）。
// cwd に依らない分（`$CODEX_HOME/skills/`・プラグイン・組み込み）はここでは読まず、app-server の `skills/list` から取る
// （プラグインのスキルは `~/.codex/plugins/cache/<namespace>/<plugin>/<version>/skills/` にあって名前も `<plugin>:<skill>` に
// なるので、置き場を真似して読むと Codex 側の見つけ方を二重に実装することになる）。
//
// **作業ディレクトリから worktree の一番上まで上へ辿る**（#885）。作業ディレクトリが `packages/…/src` のように下へ移った
// セッションでも、一番上の `.claude/skills/` を出すため。途中の各ディレクトリの置き場も読み、同じ名前は作業ディレクトリに近いほうが勝つ。
// 一番上より上（ホームなど）へは辿らない。一番上は読むだけの git（`rev-parse --show-toplevel`）で引き、引けなければ cwd だけ。
// Claude Code 2.1.319 と Codex 0.167.0 で実測した読み方に合わせている（どちらも cwd → 一番上を途中も含めて読み、一番上より上は
// 読まない。worktree ではその worktree の一番上で止まる）。git でないディレクトリでは Claude は上へ辿るが、SAI は cwd だけにする
// （候補を Claude が本当に使えるものより多くしない向きに倒す）。
//
// ディレクトリの mtime で覚えて、変わらなければ読み直さない。スキルが増えた・減ったときは mtime が変わるので拾えるが、
// 既にある SKILL.md の説明だけを書き換えたときは変わらない（候補の説明が古いままになるだけなので許容する）。
import { readdir, readFile, realpath, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, relative, sep } from 'node:path'
import { parseSkill, type Skill } from '../../shared/skills.ts'
import type { Git } from '../git/diff.ts'

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
  async forCwd(cwd: string, agent: SkillAgent = 'claude', git?: Git): Promise<Skill[]> {
    const places = cwd ? await skillPlaces(cwd, git) : []
    if (agent === 'codex') return await this.project(places, CODEX_PROJECT_SKILLS_DIRS)
    const project = await this.project(places, [PROJECT_SKILLS_DIR])
    const user = await this.read(this.userDir, 'user')
    const seen = new Set(project.map((s) => s.name))
    return [...project, ...user.filter((s) => !seen.has(s.name))]
  }

  /**
   * 各ディレクトリ（cwd に近い順）の下の置き場を順に読んで繋ぐ。同じ名前なら先に読んだほうが勝つ
   * （近いディレクトリが勝ち、同じディレクトリの中では `dirs` の前が勝つ）
   */
  private async project(places: readonly string[], dirs: readonly string[]): Promise<Skill[]> {
    const out: Skill[] = []
    const seen = new Set<string>()
    for (const place of places) {
      for (const dir of dirs) {
        for (const skill of await this.read(join(place, dir), 'project')) {
          if (seen.has(skill.name)) continue
          seen.add(skill.name)
          out.push(skill)
        }
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

/**
 * スキルを探すディレクトリ。cwd から worktree の一番上まで、cwd に近い順（#885）。
 * git が無い・一番上が引けない・cwd が一番上の外のときは cwd だけ（今までどおり）
 */
export async function skillPlaces(cwd: string, git?: Git): Promise<string[]> {
  if (!git) return [cwd]
  let real: string
  let top: string
  try {
    real = await realpath(cwd)
    top = await realpath((await git.run(real, ['rev-parse', '--show-toplevel'])).trim())
  } catch {
    return [cwd]
  }
  const rel = relative(top, real)
  if (rel === '..' || rel.startsWith(`..${sep}`) || rel.startsWith(sep)) return [cwd]
  const places: string[] = []
  for (let d = real; ; d = dirname(d)) {
    places.push(d)
    if (d === top || dirname(d) === d) break
  }
  return places
}
