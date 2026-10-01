// アーカイブしたあとに行が増えて、一覧へ戻ってきたセッション（#583）。
// アーカイブ済みかは `archived_at >= end` で決めるので、行が増えるとメタを書き換えずに戻る。戻るのは意図した動きだが、
// 「片付けたはずのセッション」に返信が届き続けているのが見えないので、見出し・サイドバー・要対応が同じこの判定で印を出す
import type { SessionSummary } from './types.ts'

/**
 * 戻ってきたセッションなら、アーカイブした時刻（`meta.archived_at`）。そうでなければ空。
 * **`archived_at` があるのに `archived` でない**ときだけ（アーカイブ済みのままなら「アーカイブ」の印が出ている）
 */
export function returnedFromArchive(s: Pick<SessionSummary, 'meta' | 'archived'>): string {
  const at = s.meta?.archived_at ?? ''
  return at && !s.archived && Number.isFinite(Date.parse(at)) ? at : ''
}

type Sibling = Pick<SessionSummary, 'id' | 'project' | 'repo' | 'host' | 'start' | 'archived'>

/**
 * 同じ worktree（`project` と `repo`、同じマシン）で、アーカイブのあとに始まった一番新しいセッション。無ければ undefined。
 * 「使うつもりだったのはこちらでは」のリンク先にする。アーカイブ済みのものと自分自身は外す
 */
export function newerSibling<T extends Sibling>(s: Sibling & Pick<SessionSummary, 'meta' | 'archived'>, peers: readonly T[]): T | undefined {
  const at = Date.parse(returnedFromArchive(s))
  if (!Number.isFinite(at)) return undefined
  let best: T | undefined
  for (const p of peers) {
    if (p.id === s.id || p.archived || p.project !== s.project || p.repo !== s.repo || p.host !== s.host) continue
    const start = Date.parse(p.start)
    if (!(start > at)) continue
    if (!best || start > Date.parse(best.start)) best = p
  }
  return best
}
