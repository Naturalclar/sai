import { useEffect, useMemo, useState } from 'react'
import { parseUnifiedDiff } from '../../shared/diff.ts'
import { api, type SessionDiffResponse } from './api'
import { DiffView } from './DiffView'
import { ReviewButton } from './ReviewButton'
import { DiffCommentBar } from './DiffCommentBar'
import { DiffCommentNote } from './DiffCommentNote'
import { commentLine, formatDiffComments, type DiffComment } from './diffComments'
import { useDiffComments } from './useDiffComments'

/**
 * そのセッションの worktree の差分の中身（#171）。開いたときに 1 回だけ取る（3 秒のポーリングには乗せない）。
 * 上が「ブランチの差分」（GitHub の PR で見るのと同じ base...HEAD）、下が「未コミット」。読むだけ。
 * 広い画面はペイン（`DiffPane`）、狭い画面はモーダル（`DiffModal`）が、これを包んで出す。
 * **Codex のセッションで、いま返信できるときだけ**、区切りごとに「レビューさせる」を出す（#403。`canReview`）
 */
export function DiffBody({ id, canReview = false, onInsertComments }: { id: string; canReview?: boolean; onInsertComments?: (text: string) => void }) {
  const [data, setData] = useState<SessionDiffResponse | null>(null)
  const [error, setError] = useState('')
  // 行へのコメント（#511）。入れる先（そのセッションの返信欄）があるときだけ書ける
  const comments = useDiffComments(id)
  // 区切りごとの口。同じものを渡し続ける（毎回作ると DiffFileItem の memo が効かず、ポーリングのたびに全ファイルが描き直る）
  const canComment = Boolean(onInsertComments)
  const branchComments = useMemo(
    () => (canComment ? { section: 'branch' as const, list: comments.list.filter((c) => c.section === 'branch'), onAdd: comments.add, onRemove: comments.remove } : undefined),
    [canComment, comments.list, comments.add, comments.remove],
  )
  const workingComments = useMemo(
    () => (canComment ? { section: 'working' as const, list: comments.list.filter((c) => c.section === 'working'), onAdd: comments.add, onRemove: comments.remove } : undefined),
    [canComment, comments.list, comments.add, comments.remove],
  )
  // いまの差分に行が見当たらないコメント（エージェントが編集して消えた・区切りが変わった）。行の下に出せないので上にまとめる
  const parsed = useMemo(
    () => (data ? { branch: parseUnifiedDiff(data.branch.patch), working: parseUnifiedDiff(data.working.patch) } : null),
    [data],
  )
  const orphans: DiffComment[] = parsed ? comments.list.filter((c) => !commentLine(c, parsed[c.section])) : []

  // id は開いている間は変わらない（別のセッションへ移ると App が閉じる）ので、取り直しのリセットは要らない
  useEffect(() => {
    let alive = true
    api
      .diff(id)
      .then((d) => alive && setData(d))
      .catch((err: unknown) => alive && setError(err instanceof Error ? err.message : String(err)))
    return () => {
      alive = false
    }
  }, [id])

  const truncated = Boolean(data && (data.branch.truncated || data.working.truncated))
  return (
    <>
      {error && <div className="err">取得失敗: {error}</div>}
      {!data && !error && <div className="none">読んでいます…</div>}
      {data && (
        <>
          {onInsertComments && (
            <DiffCommentBar
              count={comments.list.length}
              onInsert={() => {
                onInsertComments(formatDiffComments(comments.list))
                comments.clear()
              }}
              onClear={comments.clear}
            />
          )}
          {orphans.map((c) => (
            <div className="diff-orphan" key={c.id}>
              <code>{c.path}:{c.line}</code>
              <DiffCommentNote comment={c} moved onRemove={() => comments.remove(c.id)} />
            </div>
          ))}
          <div className="where">
            <code>{data.head || '(不明)'}</code>
            {data.base ? <> ← <code>{data.base}</code> からの差分</> : ' （比べる相手のブランチが見つかりません）'}
            {data.session_branch && data.head && data.session_branch !== data.head && (
              <div className="warn">このセッションが動いていたのは {data.session_branch} で、いまの worktree は {data.head} にいます</div>
            )}
          </div>
          {data.base && (
            <DiffView
              section={data.branch}
              title="ブランチの差分"
              empty={`${data.base} との差はありません`}
              action={canReview && data.branch.files.length > 0 ? <ReviewButton id={id} target="baseBranch" /> : undefined}
              comments={branchComments}
            />
          )}
          <DiffView
            section={data.working}
            title="未コミット"
            empty="コミットしていない変更はありません"
            action={canReview && data.working.files.length > 0 ? <ReviewButton id={id} target="uncommittedChanges" /> : undefined}
            comments={workingComments}
          />
          {data.untracked.length > 0 && (
            <div className="diff-section">
              <div className="head">
                追跡外のファイル<span className="n">{data.untracked.length}</span>
              </div>
              <ul className="untracked">
                {data.untracked.map((p) => (
                  <li key={p}><code>{p}</code></li>
                ))}
              </ul>
            </div>
          )}
          {truncated && (
            <div className="warn">
              差分が大きいので一部は出していません。
              {data.compare_url && (
                <>
                  {' '}
                  <a href={data.compare_url} target="_blank" rel="noopener noreferrer">GitHub で見る</a>
                </>
              )}
            </div>
          )}
        </>
      )}
    </>
  )
}
