// `project`（どのリポジトリか）の無いセッションを、cwd で git を読んで埋める（#182）。
//
// #126 より前の `record.py` が書いた行には `project` も `remote` も無い。そのままだと絞り込みの候補に
// 出せないので、worktree がまだ手元にあるうちに cwd から引く。手元で数えたところ、分からなかった
// 28 セッションのうち 19 は cwd から引けた（`AnotherBall/persona-server` が 7 件など）。
//
// 3 秒のポーリングから呼ばれるので **cwd をキーにキャッシュする**（引けなかったものも覚える）。
// 読むだけ（`remote get-url` と `rev-parse`）で、Git の allowlist もそのまま。
import { normalizeRemote, projectFromCommonDir, projectFromRemote } from '../shared/project.ts'
import type { Git } from './diff.ts'

export class ProjectResolver {
  private readonly git: Git
  /** cwd → 引けたリポジトリ（引けなければ空）。空も覚えるので、消えた cwd を毎回叩かない */
  private cache = new Map<string, string>()

  constructor(git: Git) {
    this.git = git
  }

  /** 覚えている数（テスト用） */
  get size(): number {
    return this.cache.size
  }

  /**
   * その cwd のリポジトリ。`origin` があれば `owner/repo`、無ければリポジトリ名だけ。
   * git が読めなければ空。同じ cwd は 1 回しか叩かない
   */
  async resolve(cwd: string): Promise<string> {
    const key = (cwd ?? '').trim()
    if (!key) return ''
    const hit = this.cache.get(key)
    if (hit !== undefined) return hit
    const found = await this.read(key)
    this.cache.set(key, found)
    return found
  }

  private async read(cwd: string): Promise<string> {
    // origin があれば owner/repo まで分かる。remote から来た行と同じ形になるので候補が割れない
    try {
      const url = await this.git.run(cwd, ['remote', 'get-url', 'origin'])
      const from = projectFromRemote(normalizeRemote(url))
      if (from) return from
    } catch {
      // origin が無い、git ではない
    }
    try {
      return projectFromCommonDir(cwd, await this.git.run(cwd, ['rev-parse', '--git-common-dir']))
    } catch {
      return ''
    }
  }
}

/**
 * `project` が空のセッションを cwd から埋める。埋まらなければ空のまま（絞り込みの候補には出さず、
 * 一覧の表示だけ worktree 名に落ちる）。同じ cwd は 1 回しか引かない
 */
export async function fillProjects<T extends { cwd: string; project: string; projects: string[] }>(
  resolver: ProjectResolver,
  sessions: T[],
): Promise<T[]> {
  const missing = [...new Set(sessions.filter((s) => !s.project && s.cwd).map((s) => s.cwd))]
  if (missing.length === 0) return sessions
  const found = new Map(await Promise.all(missing.map(async (cwd) => [cwd, await resolver.resolve(cwd)] as const)))
  return sessions.map((s) => {
    if (s.project) return s
    const project = found.get(s.cwd) ?? ''
    return project ? { ...s, project, projects: [...s.projects, project] } : s
  })
}
