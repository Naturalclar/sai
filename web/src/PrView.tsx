import { useCallback, useEffect, useMemo, useState } from 'react'
import { parseUnifiedDiff } from '../../shared/diff.ts'
import { replyBlockedReason } from '../../shared/reply.ts'
import { api, type PrDetailResponse, type SessionSummary } from './api'
import { DiffView } from './DiffView'
import { DiffCommentBar } from './DiffCommentBar'
import { DiffCommentNote } from './DiffCommentNote'
import { commentLine, formatDiffComments } from './diffComments'
import { useDiffComments } from './useDiffComments'
import { usePrReviewBody } from './usePrReviewBody'
import { PrReviewBar } from './PrReviewBar'
import { PrReviewModal } from './PrReviewModal'
import { REVIEW_EVENT_LABEL } from '../../shared/prReview.ts'
import type { PrReviewEvent } from './api'
import { newestFirst, prAuthorSession, prCommentKey } from './prSession'
import { Markdown } from './Markdown'
import { agoLabel, checkLabel, reviewLabel } from './prLabels'
import type { PaneProps } from './App'
import { withSuffix } from '../../shared/sessionLabels.ts'

interface Loaded {
  data: PrDetailResponse
  at: Date
}

const STATE_LABEL: Record<string, string> = { OPEN: 'open', MERGED: 'マージ済み', CLOSED: '閉じた' }

/**
 * PR 1 本（#524）。題名・出した人・ブランチ・チェック・本文と、差分を**セッションの差分と同じビューア**（`DiffView`）で出す。
 * 開いたときに 1 回と「読み直す」のときだけ取る。
 *
 * **その PR を書いたセッションが見つかれば、差分の行にコメントを書いてそのセッションの入力欄に入れられる**（#525）。
 * 書いたセッションは `prAuthorSession()`（同じリポジトリで、いまのブランチが head と同じ一番新しいもの）。
 * 直接は送らない（#511 と同じく、入れたらそのセッションへ移って人が送る）。書いたセッションが返信できなければ口は出さず理由を出す。
 *
 * **同じ下書きを GitHub にレビューとして投稿もできる**（#526。`gh` でログインしていて PR が open のとき）。確認の画面（`PrReviewModal`）で
 * GitHub に載る形を見せ、押したときだけ送る。書いたセッションが見つかる PR では入力欄に入れる方が既定で、投稿は控えめに並べる
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

  // 書いたセッションを探すための一覧。**サイドバーの絞り込みに依らず**そのリポジトリの分を 1 回だけ取る（3 秒のポーリングには乗せない）。
  // リポジトリ名はサーバが記録で知っている名前に直したもの（`loaded.data.repo`）を使う（URL の大文字小文字のままだと一覧に当たらない）。
  // アーカイブ済みも取る（書いたセッションがアーカイブ済みなら理由を出す。除くと同じブランチの古いセッションを選んでしまう）
  const knownRepo = loaded?.data.repo ?? ''
  const [sessions, setSessions] = useState<{ repo: string; host: string; list: SessionSummary[] } | null>(null)
  useEffect(() => {
    if (!knownRepo) return
    let alive = true
    const f = { projects: [knownRepo], repo: '', agent: '', date: '', host: '', days: '30' }
    void Promise.all([api.sessions({ ...f, archived: '' }), api.sessions({ ...f, archived: '1' })])
      .then(([live, archived]) => alive && setSessions({ repo: knownRepo, host: live.host, list: newestFirst(live.sessions, archived.sessions) }))
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [knownRepo])
  const pr = loaded?.data.pr
  const author = pr && sessions && sessions.repo === knownRepo ? prAuthorSession(sessions.list, knownRepo, pr.head, pr.cross_repo) : null
  const authorName = author ? withSuffix(author.meta?.name || author.title || author.id, author) : ''
  const blocked = author ? (author.archived ? 'アーカイブ済み。続けるならセッション画面で「戻す」を押してください' : replyBlockedReason(author, sessions?.host ?? '')) : ''
  const canComment = Boolean(author && !blocked && onInsertToSession)
  // GitHub への投稿（#526）。`gh` でログインしている人が引けていて、PR が open のときだけ
  const canPost = Boolean(loaded?.data.review && pr?.state === 'OPEN')
  const canWrite = canComment || canPost
  // 行へのコメント（#525）。置き場は PR ごと
  const draftKey = prCommentKey(knownRepo || repo, number)
  const comments = useDiffComments(draftKey)
  // 同じものを渡し続ける（毎回作ると DiffFileItem の memo が効かない）
  const diffComments = useMemo(
    () => (canWrite ? { section: 'branch' as const, list: comments.list, onAdd: comments.add, onRemove: comments.remove } : undefined),
    [canWrite, comments.list, comments.add, comments.remove],
  )
  const [reviewBody, setReviewBody] = usePrReviewBody(draftKey)
  const [reviewing, setReviewing] = useState(false)
  const [posted, setPosted] = useState<{ url: string; event: PrReviewEvent } | null>(null)
  const files = useMemo(() => (loaded ? parseUnifiedDiff(loaded.data.diff.patch) : null), [loaded])
  // PR が更新されて行が見当たらなくなったコメントは、差分の上にまとめて出す（DiffBody と同じ）
  const orphans = canWrite && files ? comments.list.filter((c) => !commentLine(c, files)) : []
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
          {canPost && (
            <PrReviewBar
              count={comments.list.length}
              hasBody={reviewBody.trim() !== ''}
              secondary={canComment}
              onOpen={() => {
                setPosted(null)
                setReviewing(true)
              }}
              onClear={() => {
                comments.clear()
                setReviewBody('')
              }}
            />
          )}
          {posted && (
            <div className="note pr-posted">
              GitHub にレビューを載せました（{REVIEW_EVENT_LABEL[posted.event]}）。{' '}
              <a href={posted.url || pr.url} target="_blank" rel="noopener noreferrer">GitHub で見る</a>
            </div>
          )}
          {reviewing && (
            <PrReviewModal
              data={loaded.data}
              comments={comments.list}
              onRemoveComment={comments.remove}
              body={reviewBody}
              onBody={setReviewBody}
              onReload={load}
              onPosted={(url, event) => {
                comments.clear()
                setReviewBody('')
                setReviewing(false)
                setPosted({ url, event })
                void load()
              }}
              onClose={() => setReviewing(false)}
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
              {...(diffComments ? { comments: diffComments } : {})}
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
