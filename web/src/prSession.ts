// PR の行コメントを、その PR を書いたセッションの入力欄に入れる（#525）の画面側の判定。DOM に依らないので node:test で回す（prSession.test.ts）
import type { SessionSummary } from '../../shared/types.ts'

/**
 * PR の行コメントの置き場の鍵（`sai.diffComments` の中。セッションの鍵はエンティティ ID＝`<セッション>@<リポジトリ>` なので混ざらない）。
 * **PR ごと**に持つ: 書いたセッションは後から変わりうる（別の worktree で同じブランチを開き直す）が、コメントは PR の差分の行に付いている
 */
export function prCommentKey(repo: string, number: number): string {
  return `pr:${repo}#${number}`
}

/**
 * その PR を書いたセッション。**同じリポジトリ（`project`）で、いまのブランチが PR の head と同じ**もののうち一番新しいもの。
 * 一覧は新しい順に並んでいる（`aggregate.ts`）ので最初に当たったもの。見つからなければ null（入力欄に入れる口を出さない）。
 *
 * ブランチ名は別の worktree で使い回すことがあるので当て推量ではある。そのため**画面はどのセッションに入れるかを名前で出す**
 * （違っていれば人が気づける）。行の `branch` は記録したときのもので、いまの worktree の head ではない
 */
export function prAuthorSession<S extends Pick<SessionSummary, 'project' | 'branch'>>(sessions: readonly S[], repo: string, head: string): S | null {
  if (!repo || !head) return null
  const want = repo.toLowerCase()
  return sessions.find((s) => (s.project ?? '').toLowerCase() === want && s.branch === head) ?? null
}
