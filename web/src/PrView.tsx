import { useCallback, useEffect, useMemo, useState } from 'react'
import { parseUnifiedDiff } from '../../shared/diff.ts'
import { replyBlockedReason } from '../../shared/reply.ts'
import { api, type PrDetailResponse, type SessionsResponse } from './api'
import { DiffView } from './DiffView'
import { DiffCommentBar } from './DiffCommentBar'
import { DiffCommentNote } from './DiffCommentNote'
import { commentLine, formatDiffComments } from './diffComments'
import { useDiffComments } from './useDiffComments'
import { prAuthorSession, prCommentKey } from './prSession'
import { Markdown } from './Markdown'
import { agoLabel, checkLabel, reviewLabel } from './prLabels'
import type { PaneProps } from './App'

interface Loaded {
  data: PrDetailResponse
  at: Date
}

const STATE_LABEL: Record<string, string> = { OPEN: 'open', MERGED: 'マージ済み', CLOSED: '閉じた' }

/**
 * PR 1 本（#524）。題名・出した人・ブランチ・チェック・本文と、差分を**セッションの差分と同じビューア**（`DiffView`）で出す。
 * 開いたときに 1 回と「読み直す」のときだけ取る。**GitHub には書かない**（投稿は #526）。
 *
 * **その PR を書いたセッションが見つかれば、差分の行にコメントを書いてそのセッションの入力欄に入れられる**（#525）。
 * 書いたセッションは `prAuthorSession()`（同じリポジトリで、いまのブランチが head と同じ一番新しいもの）。
 * 直接は送らない（#511 と同じく、入れたらそのセッションへ移って人が送る）。書いたセッションが返信できなければ口は出さず理由を出す
 */
export function PrView({ repo, number, onStatus, onInsertToSession }: { repo: string; number: number; onInsertToSession?: (id: string, text: string) => void } & Pick<PaneProps, 'onStatus'>) {
  const [loaded, setLoaded] = useState<Loaded | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(true)

  const load = useCallback(() => {
    setBusy(true)
    return api.pr(repo, number).then(
      (data) => {
        setLoaded({ data, at: new Date() })
        setError('')
        setBusy(false)
      },
      (err: unknown) => {
        setError(err instanceof Error ? err.message : String(err))
        setBusy(false)
      },
    )
  }, [repo, number])

  // 別の PR に移ったら前の PR の中身は出さない（key で作り直すので、ここでは 1 回取るだけ）
  useEffect(() => {
    let alive = true
    void api.pr(repo, number).then(
      (data) => alive && (setLoaded({ data, at: new Date() }), setBusy(false)),
      (err: unknown) => alive && (setError(err instanceof Error ? err.message : String(err)), setBusy(false)),
    )
    return () => {
      alive = false
    }
  }, [repo, number])

  useEffect(() => onStatus(loaded?.at ?? null, error || null), [loaded, error, onStatus])

  // 書いたセッションを探すための一覧。**サイドバーの絞り込みに依らず**そのリポジトリの分を 1 回だけ取る（3 秒のポーリングには乗せない）
  const [sessions, setSessions] = useState<SessionsResponse | null>(null)
  useEffect(() => {
    let alive = true
    void api
      .sessions({ projects: [repo], repo: '', agent: '', date: '', host: '', days: '30', archived: '' })
      .then((d) => alive && setSessions(d))
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [repo])

  const pr = loaded?.data.pr
  const author = pr && sessions ? prAuthorSession(sessions.sessions, repo, pr.head) : null
  const authorName = author ? author.meta?.name || author.title || author.id : ''
  const blocked = author ? (author.archived ? 'アーカイブ済み' : replyBlockedReason(author, sessions?.host ?? '')) : ''
  const canComment = Boolean(author && !blocked && onInsertToSession)
  // 行へのコメント（#525）。置き場は PR ごと
  const comments = useDiffComments(prCommentKey(repo, number))
  const files = useMemo(() => (loaded ? parseUnifiedDiff(loaded.data.diff.patch) : null), [loaded])
  // PR が更新されて行が見当たらなくなったコメントは、差分の上にまとめて出す（DiffBody と同じ）
  const orphans = canComment && files ? comments.list.filter((c) => !commentLine(c, files)) : []
  const check = pr ? checkLabel(pr.checks) : null
  const review = pr ? reviewLabel(pr.review_decision) : ''

  return (
    <section className="pr-view">
      <a className="back pr-back" href="#/prs">← PR 一覧</a>
      <div className="chat-head">
        <h1>
          {pr ? pr.title : `${repo}#${number}`} <span className="num">#{number}</span>
        </h1>
        <span className="pr-actions">
          {pr?.url && (
            <a href={pr.url} target="_blank" rel="noopener noreferrer">
              GitHub で開く
            </a>
          )}
          <button type="button" onClick={() => void load()} disabled={busy}>
            {busy ? '読んでいます…' : '読み直す'}
          </button>
        </span>
      </div>
      {error && !loaded && <div className="empty">取得失敗: {error}</div>}
      {!loaded && !error && <div className="empty">読んでいます…</div>}
      {pr && loaded && (
        <div className="pr-body">
          <div className="pr-meta">
            <span className={`tag state ${pr.state.toLowerCase()}`}>{STATE_LABEL[pr.state] ?? pr.state}</span>
            {pr.draft && <span className="tag">下書き</span>}
            {pr.requested && <span className="tag requested">レビュー依頼</span>}
            <span className="author">{pr.author}</span>
            <span>
              <code>{pr.head}</code> → <code>{pr.base}</code>
            </span>
            {check && (
              <span className={`check ${pr.checks}`} title={check.title}>
                {check.mark} {check.title}
              </span>
            )}
            {review && <span className={`review ${pr.review_decision.toLowerCase()}`}>{review}</span>}
            <span className="ago">{agoLabel(pr.updated_at, loaded.at.getTime())}に更新</span>
            <span className="repo">{loaded.data.repo}</span>
          </div>
          <div className="pr-description body">{pr.body.trim() ? <Markdown text={pr.body} /> : <span className="none">本文はありません</span>}</div>
          {loaded.data.diff_error && <div className="warn">{loaded.data.diff_error}</div>}
          {author && blocked && (
            <div className="note pr-author">この PR を書いたセッション「{authorName}」には返信できないので、行へのコメントは書けません（{blocked}）</div>
          )}
          {canComment && author && (
            <DiffCommentBar
              count={comments.list.length}
              target={authorName}
              onInsert={() => {
                onInsertToSession?.(author.id, formatDiffComments(comments.list, `PR #${number}「${pr.title}」の差分へのコメントです（${pr.url}）。`))
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
          {!loaded.data.diff_error && (
            <DiffView
              section={loaded.data.diff}
              title="変更"
              empty="差分はありません"
              {...(canComment
                ? { comments: { section: 'branch' as const, list: comments.list, onAdd: comments.add, onRemove: comments.remove } }
                : {})}
            />
          )}
          {loaded.data.diff.truncated && (
            <div className="warn">
              差分が大きいので一部は出していません。{' '}
              <a href={`${pr.url}/files`} target="_blank" rel="noopener noreferrer">GitHub で見る</a>
            </div>
          )}
        </div>
      )}
    </section>
  )
}
