// `project`（どのリポジトリか）と `remote`（origin の URL）の無いセッションを、cwd で git を読んで埋める（#182、#212）。
//
// #126 より前の `record.py` が書いた行には `project` も `remote` も無い。そのままだと絞り込みの候補に
// 出せないので、worktree がまだ手元にあるうちに cwd から引く。手元で数えたところ、分からなかった
// 28 セッションのうち 19 は cwd から引けた（`AnotherBall/persona-server` が 7 件など）。
//
// `remote` は見出しのリポジトリへのリンク（#212）の飛び先。origin の URL は `project` を出すために
// どのみち読んでいるので、`owner/repo` を取ったあと**捨てずに一緒に載せる**。
//
// 3 秒のポーリングから呼ばれるので **cwd をキーにキャッシュする**（引けなかったものも覚える）。
// 読むだけ（`remote get-url` と `rev-parse`）で、Git の allowlist もそのまま。
import { normalizeRemote, projectFromCommonDir, projectFromRemote } from '../../shared/project.ts'
import type { Git } from './diff.ts'

/** cwd から引けたもの。`--git-common-dir` に落ちたときは名前だけ分かって `remote` は空 */
export interface RepoInfo {
  /** `owner/repo`、または origin が無ければリポジトリ名だけ */
  project: string
  /** 正規化済みの origin の URL。無ければ空 */
  remote: string
}

const NOTHING: RepoInfo = { project: '', remote: '' }

export class ProjectResolver {
  private readonly git: Git
  /** cwd → 引けたリポジトリ（引けなければ空）。空も覚えるので、消えた cwd を毎回叩かない */
  private cache = new Map<string, RepoInfo>()

  constructor(git: Git) {
    this.git = git
  }

  /** 覚えている数（テスト用） */
  get size(): number {
    return this.cache.size
  }

  /**
   * その cwd のリポジトリ。`origin` があれば `owner/repo` と URL、無ければリポジトリ名だけ。
   * git が読めなければ両方空。同じ cwd は 1 回しか叩かない
   */
  async resolve(cwd: string): Promise<RepoInfo> {
    const key = (cwd ?? '').trim()
    if (!key) return NOTHING
    const hit = this.cache.get(key)
    if (hit !== undefined) return hit
    const found = await this.read(key)
    this.cache.set(key, found)
    return found
  }

  private async read(cwd: string): Promise<RepoInfo> {
    // origin があれば owner/repo まで分かる。remote から来た行と同じ形になるので候補が割れない
    try {
      const remote = normalizeRemote(await this.git.run(cwd, ['remote', 'get-url', 'origin']))
      const project = projectFromRemote(remote)
      if (project) return { project, remote }
    } catch {
      // origin が無い、git ではない
    }
    try {
      return { project: projectFromCommonDir(cwd, await this.git.run(cwd, ['rev-parse', '--git-common-dir'])), remote: '' }
    } catch {
      return NOTHING
    }
  }
}

/** 埋める対象。行から来た値が正なので、**空いているところにしか入れない** */
interface Fillable {
  cwd: string
  project: string
  projects: string[]
  remote: string
}

/**
 * `project` / `remote` の空いているセッションを cwd から埋める。埋まらなければ空のまま
 * （`project` が空なら絞り込みの候補には出さず、一覧の表示だけ worktree 名に落ちる。`remote` が空ならリンクを出さない）。
 * 同じ cwd は 1 回しか引かない
 */
export async function fillRepo<T extends Fillable>(resolver: ProjectResolver, sessions: T[]): Promise<T[]> {
  const missing = [...new Set(sessions.filter((s) => (!s.project || !s.remote) && s.cwd).map((s) => s.cwd))]
  if (missing.length === 0) return sessions
  const found = new Map(await Promise.all(missing.map(async (cwd) => [cwd, await resolver.resolve(cwd)] as const)))
  return sessions.map((s) => {
    if (s.project && s.remote) return s
    const info = found.get(s.cwd) ?? NOTHING
    const project = s.project || info.project
    const remote = s.remote || info.remote
    if (project === s.project && remote === s.remote) return s
    const out = { ...s, remote }
    // 候補の一覧にも足す（絞り込みの選択肢。すでに入っていれば足さない）
    if (project !== s.project) {
      out.project = project
      if (!out.projects.includes(project)) out.projects = [...out.projects, project]
    }
    return out
  })
}
