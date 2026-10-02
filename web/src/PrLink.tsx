import type { SessionDiffSummaryResponse } from './api'
import { ApprovedMark } from './ApprovedMark'
import { GitHubMark } from './GitHubMark'
import { prLink } from './diffCount'

/**
 * 差分ボタンの横の、いまのブランチの PR へのリンク（#536）。GitHub の印 + `#番号` で、押すと別のタブで開く。
 * 番号は差分ボタンの中にも出ていたが、ボタンの一部なので押すと差分のトグルになり PR には飛べなかった。
 * 状態（下書き・マージ済み・クローズ済み）は色で分け、言葉は title に出す。承認済みはチェックの印も付ける（#636）。PR が無い・url が取れなければ何も出さない
 */
export function PrLink({ pr }: { pr: SessionDiffSummaryResponse['pr'] }) {
  const link = prLink(pr)
  if (!link) return null
  return (
    <a className={`pr-link ${link.state}`} href={link.url} target="_blank" rel="noopener noreferrer" title={link.title}>
      <GitHubMark size={13} />
      {link.label}
      {link.state === 'approved' && <ApprovedMark size={12} />}
    </a>
  )
}
