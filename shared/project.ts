// 行がどのリポジトリのものか（`project`）。
//
// `repo` は git の toplevel の basename なので、bare clone の worktree（`…/sai.git/dev-min`）だと
// **worktree 名**になる（#163）。それだと一覧の絞り込みが worktree ごとに分かれて役に立たないし、
// 別のリポジトリの worktree が同じ名前（`main`）だと同じ値になってしまう。
// 記録側（feed/record.py の git_project）が `project` を載せるが、それ以前の行には無いので、
// ここで remote から補い、最後は repo に落とす。
import type { FeedRow } from './types.ts'

/**
 * 正規化済みの remote（`https://github.com/Naturalclar/sai`）から `owner/repo`。
 * GitLab のサブグループ（`https://host/grp/sub/repo`）は最後の2つ（`sub/repo`）。読めなければ空
 */
export function projectFromRemote(remote: string | undefined): string {
  const path = (remote ?? '').trim().replace(/^[a-z]+:\/\/[^/]+\//i, '').replace(/\/+$/, '')
  if (!path || path.includes('://')) return ''
  const parts = path.split('/').filter(Boolean)
  if (parts.length < 2) return ''
  return parts.slice(-2).join('/')
}

/** 行のリポジトリ。record.py が載せた project → remote から補う → repo（worktree 名）の順 */
export function rowProject(row: Pick<FeedRow, 'project' | 'remote' | 'repo'>): string {
  return (row.project ?? '').trim() || projectFromRemote(row.remote) || (row.repo ?? '').trim()
}

/** 表示用の短い名前。`Naturalclar/sai` → `sai` */
export function projectName(project: string): string {
  const parts = (project ?? '').split('/').filter(Boolean)
  return parts[parts.length - 1] ?? ''
}
