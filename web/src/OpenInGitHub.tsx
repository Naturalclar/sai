import { GitHubMark } from './GitHubMark'

/** 見えるリンクの文言（#655）。ホバーの説明（`PrListView` と `diffCount.ts` の `prLink()`）は同じ文言を自分で書いている */
const OPEN_IN_GITHUB = 'Open in GitHub'

/**
 * GitHub へ出るリンク（#655）。GitHub の印 + 「Open in GitHub」の**ボタンの形**で、別のタブで開く（飛ぶ先があるので中身は `<a>` のまま）。前は場所ごとに「GitHub で開く」
 * 「GitHub で見る」と文字だけで書いていた。`compact` は見出しのボタン用で、**狭い画面では文字を隠して印だけ**にする
 * （「更新」と同じ。文中のリンクは印だけだと何のリンクか分からないので渡さない）。読み上げと title は `compact` のときに付ける
 */
export function OpenInGitHub({ href, compact = false }: { href: string; compact?: boolean }) {
  return (
    <a
      className={`open-in-github${compact ? ' compact' : ''}`}
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      {...(compact ? { 'aria-label': OPEN_IN_GITHUB, title: OPEN_IN_GITHUB } : {})}
    >
      <GitHubMark size={14} />
      <span className="label">{OPEN_IN_GITHUB}</span>
    </a>
  )
}
