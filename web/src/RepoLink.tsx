import { repoLink } from '../../shared/project.ts'
import { GitHubMark } from './GitHubMark'
import { RepoMark } from './RepoMark'

interface Props {
  /** SessionSummary.project（`Naturalclar/sai`） */
  project: string
  /** SessionSummary.remote（正規化済みの origin。飛び先） */
  remote: string
}

/**
 * チャット見出しの、そのセッションのリポジトリへのリンク（#212）。
 * **`remote` が無ければ何も出さない**（飛び先が無い。origin の無いリポジトリはここに当たる）。
 * ロゴは `github.com` のときだけ GitHub のもので、それ以外は汎用のリポジトリの印にする
 */
export function RepoLink({ project, remote }: Props) {
  const link = repoLink({ project, remote })
  if (!link) return null
  return (
    <a className="meta repo-link" href={link.url} target="_blank" rel="noopener noreferrer" title={link.url}>
      {link.github ? <GitHubMark size={14} /> : <RepoMark />}
      {link.label}
    </a>
  )
}
