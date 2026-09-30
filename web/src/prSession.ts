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
 * 渡す一覧は新しい順（`newestFirst()`。アーカイブ済みも混ぜる——混ぜないと、書いたセッションがアーカイブ済みのとき同じブランチの古いセッションを選んでしまう）。見つからなければ null（入力欄に入れる口を出さない）。
 *
 * ブランチ名は別の worktree で使い回すことがあるので当て推量ではある。そのため**画面はどのセッションに入れるかを名前で出す**
 * （違っていれば人が気づける）。行の `branch` は記録したときのもので、いまの worktree の head ではない
 */
export function prAuthorSession<S extends Pick<SessionSummary, 'project' | 'branch'>>(sessions: readonly S[], repo: string, head: string, crossRepo = false): S | null {
  // フォークから出た PR の head は出した人のリポジトリのブランチ（`contributor:main` など）。名前が同じでも手元のセッションとは関係が無い
  if (crossRepo || !repo || !head) return null
  const want = repo.toLowerCase()
  return sessions.find((s) => (s.project ?? '').toLowerCase() === want && s.branch === head) ?? null
}

/**
 * いつもの一覧とアーカイブ済みの一覧を 1 つにして新しい順（最後に動いた時刻 `end`）に並べる。
 * 同じ id が両方にあれば先の方を残す
 */
export function newestFirst<S extends Pick<SessionSummary, 'id' | 'end'>>(...lists: readonly (readonly S[])[]): S[] {
  const seen = new Set<string>()
  const out: S[] = []
  for (const list of lists) {
    for (const s of list) {
      if (seen.has(s.id)) continue
      seen.add(s.id)
      out.push(s)
    }
  }
  return out.sort((a, b) => (a.end < b.end ? 1 : a.end > b.end ? -1 : 0))
}
