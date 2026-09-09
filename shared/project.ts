// 行がどのリポジトリのものか（`project`）。
//
// `repo` は git の toplevel の basename なので、bare clone の worktree（`…/sai.git/dev-min`）だと
// **worktree 名**になる（#163）。それだと一覧の絞り込みが worktree ごとに分かれて役に立たないし、
// 別のリポジトリの worktree が同じ名前（`main`）だと同じ値になってしまう。
//
// 記録側（feed/record.py の git_project）が `project` を載せるが、それ以前の行には無い。
// **分からないときは空を返す**（`repo` には落とさない）。worktree 名を混ぜると絞り込みの候補が
// 汚れるため（#182）。空のセッションはサーバが cwd から git で引いて埋める（server/project.ts）。
import type { FeedRow } from './types.ts'

/**
 * origin の URL を `https://host/owner/repo` に正規化する。feed/record.py の normalize_remote() と同じ答え。
 * `git@host:o/r.git`、`ssh://git@host:2222/o/r.git`、認証情報つきも同じ形にし、末尾の `.git` は落とす。
 * ローカルパスなど読めない形は空
 */
export function normalizeRemote(url: string | undefined): string {
  const u = (url ?? '').trim()
  if (!u) return ''
  let host = ''
  let path = ''
  if (u.includes('://')) {
    const [scheme, rest] = [u.slice(0, u.indexOf('://')), u.slice(u.indexOf('://') + 3)]
    if (!['http', 'https', 'ssh', 'git'].includes(scheme)) return ''
    const slash = rest.indexOf('/')
    if (slash < 0) return ''
    host = rest.slice(0, slash).split('@').pop()!.split(':')[0]!
    path = rest.slice(slash + 1)
  } else {
    const m = u.match(/^(?:[\w.-]+@)?([\w.-]+):(.+)$/)
    if (!m) return ''
    host = m[1]!
    path = m[2]!
  }
  path = path.replace(/^\/+|\/+$/g, '')
  if (path.endsWith('.git')) path = path.slice(0, -4)
  if (!host || !path || !path.includes('/')) return ''
  return `https://${host}/${path}`
}

/**
 * 正規化済みの remote（`https://github.com/Naturalclar/sai`）から `owner/repo`。
 * GitLab のサブグループ（`https://host/grp/sub/repo`）は最後の2つ（`sub/repo`）。読めなければ空
 */
export function projectFromRemote(remote: string | undefined): string {
  const path = (remote ?? '')
    .trim()
    .replace(/^[a-z]+:\/\/[^/]+\//i, '')
    .replace(/\/+$/, '')
  if (!path || path.includes('://')) return ''
  const parts = path.split('/').filter(Boolean)
  if (parts.length < 2) return ''
  return parts.slice(-2).join('/')
}

/**
 * `git rev-parse --git-common-dir` の答えからリポジトリ名だけを取る。feed/record.py の git_project() と同じ判定。
 * どの形でも共有の .git を指すので、そこから名前が取れる:
 *   普通の clone  → `.git` / `../../.git`（cwd からの相対） → 親の basename が `sai`
 *   その worktree → `/…/sai/.git`                          → 同上
 *   bare clone    → `/…/sai.git`                           → `.git` を落として `sai`
 * cwd は相対の common-dir を解決するのに使う。読めなければ空
 */
export function projectFromCommonDir(cwd: string, commonDir: string): string {
  const common = (commonDir ?? '').trim()
  if (!common) return ''
  const abs = common.startsWith('/') ? common : `${(cwd ?? '').replace(/\/+$/, '')}/${common}`
  // `/a/b/../../.git` のような相対を畳む
  const parts: string[] = []
  for (const seg of abs.split('/')) {
    if (!seg || seg === '.') continue
    if (seg === '..') parts.pop()
    else parts.push(seg)
  }
  const name = parts[parts.length - 1] ?? ''
  if (name === '.git') return parts[parts.length - 2] ?? ''
  return name.endsWith('.git') ? name.slice(0, -4) : name
}

/**
 * 行のリポジトリ。`record.py` が載せた `project` → `remote` から補う、の順。
 * **分からなければ空**（worktree 名には落とさない。#182）
 */
export function rowProject(row: Pick<FeedRow, 'project' | 'remote'>): string {
  return (row.project ?? '').trim() || projectFromRemote(row.remote)
}

/** 表示用の短い名前。`Naturalclar/sai` → `sai` */
export function projectName(project: string): string {
  const parts = (project ?? '').split('/').filter(Boolean)
  return parts[parts.length - 1] ?? ''
}

/**
 * 正規化済みの remote のホスト（`https://github.com/o/r` → `github.com`）。
 * normalizeRemote() を通ったものだけを渡す前提なので、その形でなければ空
 */
export function remoteHost(remote: string | undefined): string {
  return (remote ?? '').trim().match(/^https:\/\/([^/]+)\//)?.[1] ?? ''
}

/** 見出しに出すリポジトリへのリンク（#212） */
export interface RepoLink {
  /** 飛び先。正規化済みの remote そのもの */
  url: string
  /** 出す文字（`Naturalclar/sai`） */
  label: string
  host: string
  /** GitHub のロゴを出してよいか */
  github: boolean
}

/**
 * セッションのリポジトリへのリンク。**remote が無ければ null**（飛び先が無いので何も出さない）。
 * ラベルは `project`、無ければ remote のパスから作る。
 * ロゴは `github.com` のときだけ GitHub のものにする（GitLab や self-hosted に GitHub のロゴを出さない）
 */
export function repoLink(s: { project?: string; remote?: string }): RepoLink | null {
  const url = (s.remote ?? '').trim()
  const host = remoteHost(url)
  if (!host) return null
  const label = (s.project ?? '').trim() || projectFromRemote(url)
  if (!label) return null
  return { url, label, host, github: host === 'github.com' }
}
