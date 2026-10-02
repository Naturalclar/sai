// PR の一覧と 1 本の画面（#524）に出す短い言い換え。DOM に触らないので prLabels.test.ts を node:test で回す。
import type { PrCheckState, PrRepo, PrSummary } from '../../shared/types.ts'

/** チェック（CI）の印と説明。チェックが無ければ null（何も出さない） */
export function checkLabel(state: PrCheckState): { mark: string; title: string } | null {
  if (state === 'success') return { mark: '✓', title: 'チェックは通っています' }
  if (state === 'failure') return { mark: '✗', title: '落ちたチェックがあります' }
  if (state === 'pending') return { mark: '●', title: 'チェックが走っています' }
  return null
}

/** 承認済みか（GitHub の `reviewDecision` が `APPROVED`）。チェックの印（`ApprovedMark`）を出すかはここ 1 か所で決める（#636） */
export function isApproved(decision: string | undefined): boolean {
  return decision === 'APPROVED'
}

/** レビューの判定。GitHub の `reviewDecision`。無い・知らない値は空 */
export function reviewLabel(decision: string): string {
  if (decision === 'APPROVED') return '承認済み'
  if (decision === 'CHANGES_REQUESTED') return '修正の依頼あり'
  if (decision === 'REVIEW_REQUIRED') return 'レビュー待ち'
  return ''
}

/** 最後に動いてからの経過（`5 分前` / `3 時間前` / `2 日前`）。now は描画側が渡す（描画中に Date.now() を呼ばない） */
export function agoLabel(iso: string, now: number): string {
  const t = Date.parse(iso)
  if (!Number.isFinite(t) || !now) return ''
  const min = Math.max(0, Math.floor((now - t) / 60000))
  if (min < 1) return 'いま'
  if (min < 60) return `${min} 分前`
  const h = Math.floor(min / 60)
  if (h < 24) return `${h} 時間前`
  return `${Math.floor(h / 24)} 日前`
}

/** 自分にレビューが頼まれているものだけに絞る（`requestedOnly`）。PR が 1 本も残らないリポジトリは落とす */
export function filterRepos(repos: readonly PrRepo[], requestedOnly: boolean): PrRepo[] {
  if (!requestedOnly) return [...repos]
  return repos.map((r) => ({ ...r, prs: r.prs.filter((p) => p.requested) })).filter((r) => r.prs.length > 0)
}

/** 自分に頼まれている PR の数（一覧の見出しとサイドバーに出す） */
export function requestedCount(repos: readonly { prs: readonly PrSummary[] }[]): number {
  return repos.reduce((n, r) => n + r.prs.filter((p) => p.requested).length, 0)
}
