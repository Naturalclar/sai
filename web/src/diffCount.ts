import type { SessionDiffSummaryResponse } from './api'

/**
 * ボタンに出す行数の丸め方（#211）。入力欄の中の狭いボタンなので、4 桁からは `1.2k` にする。
 * 1000 未満はそのまま（`+842`）、10000 以上は小数を落とす（`12k`）
 */
export function shortCount(n: number): string {
  if (n < 1000) return String(n)
  const k = n / 1000
  return k < 10 ? `${(Math.floor(k * 10) / 10).toFixed(1)}k` : `${Math.floor(k)}k`
}

/** 差分があるか。ファイルが変わっていれば行数が 0（バイナリだけ）でも「ある」 */
export function hasDiff(s: SessionDiffSummaryResponse): boolean {
  return s.files > 0 || s.untracked > 0 || Boolean(s.pr)
}

/** `gh pr view` の state を日本語に。open は「PR」とだけ出す（普段はこれ） */
export function prState(pr: NonNullable<SessionDiffSummaryResponse['pr']>): string {
  if (pr.state === 'MERGED') return 'マージ済み'
  if (pr.state === 'CLOSED') return 'クローズ済み'
  return pr.draft ? '下書き' : 'オープン'
}

/**
 * ボタンの title（マウスを乗せたときの内訳）。ボタン自体は合計しか出さないので、
 * ブランチの差分と未コミットの内訳・追跡外・PR の状態はここに出す
 */
export function diffTitle(s: SessionDiffSummaryResponse | null, open: boolean): string {
  const how = open ? '差分を閉じる' : '差分を見る'
  if (!s) return how
  const lines = [how]
  if (s.base) lines.push(`ブランチの差分（${s.base}...${s.head || 'HEAD'}）: ${s.branch.files} ファイル +${s.branch.added} -${s.branch.removed}`)
  else lines.push('比べる相手のブランチが見つかりません')
  lines.push(`未コミット: ${s.working.files} ファイル +${s.working.added} -${s.working.removed}`)
  if (s.untracked > 0) lines.push(`追跡外: ${s.untracked} ファイル`)
  if (s.pr) lines.push(`PR #${s.pr.number}（${prState(s.pr)}）`)
  return lines.join('\n')
}

/** PR のリンクの見た目の区別（#536）。色だけ変える。開いているものが普段の形 */
export type PrLinkState = 'open' | 'draft' | 'merged' | 'closed'

export interface PrLinkInfo {
  url: string
  label: string
  state: PrLinkState
  title: string
}

/**
 * 差分ボタンの横に出す PR へのリンク（#536）。`gh pr view` の `url` をそのまま飛び先にするので、
 * **`https://` で始まるものだけ**通す（`javascript:` などを href に入れない）。番号か url が無ければ null（出さない）
 */
export function prLink(pr: SessionDiffSummaryResponse['pr']): PrLinkInfo | null {
  if (!pr || pr.number <= 0 || !/^https:\/\//i.test(pr.url)) return null
  const state: PrLinkState = pr.state === 'MERGED' ? 'merged' : pr.state === 'CLOSED' ? 'closed' : pr.draft ? 'draft' : 'open'
  return { url: pr.url, label: `#${pr.number}`, state, title: `PR #${pr.number}（${prState(pr)}）を GitHub で開く` }
}
