import { RefreshButton } from './RefreshButton'
import { useEffect, useMemo, useRef, useState } from 'react'
import { parseUnifiedDiff } from '../../shared/diff.ts'
import { moveToBody, REVIEW_EVENT_LABEL, reviewEmptyReason, reviewEvents, reviewLineState } from '../../shared/prReview.ts'
import { api, ApiError, type PrDetailResponse, type PrReviewEvent } from './api'
import type { DiffComment } from './diffComments'

interface Props {
  data: PrDetailResponse
  /** その PR の行コメントの下書き */
  comments: readonly DiffComment[]
  onRemoveComment: (id: string) => void
  /** 全体のコメントの下書き */
  body: string
  onBody: (body: string) => void
  /** PR を取り直す（head が進んでいたとき。ボタンは「更新」） */
  onReload: () => Promise<unknown>
  /** 投稿できた。下書きを消して、レビューへのリンクを出すのは呼ぶ側 */
  onPosted: (url: string, event: PrReviewEvent) => void
  onClose: () => void
}

const EVENT_HINT: Record<PrReviewEvent, string> = {
  COMMENT: 'コメントだけ（承認も変更要求もしない）',
  APPROVE: 'この PR を承認する',
  REQUEST_CHANGES: '変更を求める（全体のコメントが要ります）',
}

const SIDE_LABEL = { old: '消した行', new: '' } as const

/**
 * GitHub にレビューを投稿する前の確認（#526）。**GitHub に載る形をそのまま**出す: 全体のコメント・種類・行ごとのコメント
 * （並びは GitHub と同じく入力欄が上、種類が下。#649）。
 * 人が「GitHub に送る」を押したときだけ送る。
 *
 * - 開いたときに PR を読み直し、head が進んでいれば送らせない（読み直させる）。サーバも同じことを確かめる
 * - いまの差分で行が変わった・見当たらないコメント（#511 の「行が変わりました」）は、外すか全体のコメントに移すまで送らせない
 *   （差分に無い行へのコメントは GitHub が 422 で断る。黙って送らない・黙って落とさない）
 * - 種類の既定は Comment。自分の PR には Approve / Request changes を出さない
 */
export function PrReviewModal({ data, comments, onRemoveComment, body, onBody, onReload, onPosted, onClose }: Props) {
  const { repo, pr } = data
  const own = data.review?.own ?? false
  const events = reviewEvents(own)
  const [event, setEvent] = useState<PrReviewEvent>('COMMENT')
  const [latestHead, setLatestHead] = useState('')
  const [checking, setChecking] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const ref = useRef<HTMLDivElement>(null)
  const bodyRef = useRef<HTMLTextAreaElement>(null)
  const files = useMemo(() => parseUnifiedDiff(data.diff.patch), [data.diff.patch])
  const lines = comments.map((c) => ({ comment: c, state: reviewLineState(files, c) }))
  const stale = lines.filter((l) => l.state !== 'ok').length
  const headMoved = latestHead !== '' && latestHead !== pr.head_sha
  const empty = reviewEmptyReason(event, body, comments.length)
  const blocked = checking ? 'PR が進んでいないか確かめています…' : headMoved ? 'PR が読んだあとに進みました。更新してください' : stale > 0 ? `行が変わったコメントが ${stale} 件あります。外すか全体のコメントに移してください` : empty

  // 開いたらすぐ書けるように、全体のコメントの欄にフォーカスを入れる（#649。GitHub と同じ）。打ちかけがあれば末尾から続ける。
  // タッチ端末では入れない（ソフトキーボードが出て、種類と行ごとのコメントが隠れる）。Esc は欄からも枠の onKeyDown に上がってくる
  useEffect(() => {
    const el = bodyRef.current
    if (!el || window.matchMedia('(hover: none) and (pointer: coarse)').matches) return ref.current?.focus()
    el.focus()
    el.setSelectionRange(el.value.length, el.value.length)
  }, [])

  // 開いたときに head を確かめる（画面を開いたまま時間が経っていることがある）
  useEffect(() => {
    let alive = true
    void api.pr(repo, pr.number).then(
      (fresh) => alive && (setLatestHead(fresh.pr.head_sha), setChecking(false)),
      () => alive && setChecking(false),
    )
    return () => {
      alive = false
    }
  }, [repo, pr.number])

  const reload = () => {
    setChecking(true)
    setError('')
    void onReload().finally(() => {
      setLatestHead('')
      setChecking(false)
    })
  }

  const send = () => {
    if (blocked || busy) return
    setBusy(true)
    setError('')
    api
      .postPrReview(repo, pr.number, {
        event,
        body,
        commit_id: pr.head_sha,
        comments: comments.map(({ path, side, line, code, body: text }) => ({ path, side, line, code, body: text })),
      })
      .then(
        (r) => onPosted(r.url, r.event),
        (err: unknown) => {
          setBusy(false)
          if (err instanceof ApiError && err.code === 'head_moved') setLatestHead('moved')
          setError(err instanceof Error ? err.message : String(err))
        },
      )
  }

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && !busy && onClose()}>
      <div
        ref={ref}
        tabIndex={-1}
        className="modal pr-review"
        role="dialog"
        aria-modal="true"
        aria-label="GitHub にレビューを投稿"
        onKeyDown={(e) => {
          if (e.key !== 'Escape') return
          // App の Esc（フィードへ）まで動かさない
          e.stopPropagation()
          // 日本語入力の変換をやめる Esc では閉じない（開くと入力欄にフォーカスが入るので、ここを通るのが普通になった。#649）
          if (e.nativeEvent.isComposing || e.keyCode === 229) return
          if (!busy) onClose()
        }}
      >
        <div className="title">
          GitHub にレビューを投稿 <span className="dim">{repo}#{pr.number}</span>
        </div>
        <div className="note">
          押すまで何も送りません。下の内容がそのまま GitHub に載ります（<code>{pr.head_sha.slice(0, 7)}</code> の差分に付けます）
        </div>
        {headMoved && (
          <div className="warn">
            PR が読んだあとに進みました。{' '}
            <RefreshButton busy={checking} onClick={reload} linkish />
          </div>
        )}
        <label className="pr-review-body">
          <span>全体のコメント</span>
          <textarea ref={bodyRef} value={body} onChange={(e) => onBody(e.target.value)} rows={4} placeholder={event === 'REQUEST_CHANGES' ? '何を直してほしいか（必須）' : '（なくてもよい）'} />
        </label>
        <fieldset className="pr-review-event">
          <legend>種類</legend>
          {events.map((e) => (
            <label key={e} className={e === event ? 'on' : ''}>
              <input type="radio" name="pr-review-event" value={e} checked={e === event} onChange={() => setEvent(e)} />
              <b>{REVIEW_EVENT_LABEL[e]}</b> <span className="dim">{EVENT_HINT[e]}</span>
            </label>
          ))}
          {own && <div className="note">自分の PR なので Comment だけです（GitHub が自分の PR への承認・変更要求を受けません）</div>}
        </fieldset>
        <div className="pr-review-lines">
          <div className="head">行ごとのコメント {comments.length} 件</div>
          {lines.length === 0 && <div className="dim">ありません</div>}
          {lines.map(({ comment: c, state }) => (
            <div key={c.id} className={`pr-review-line ${state}`}>
              <code className="where">
                {c.path}:{c.line}
                {SIDE_LABEL[c.side] && `（${SIDE_LABEL[c.side]}）`}
              </code>
              <pre className="quote">{c.code}</pre>
              <div className="body">{c.body}</div>
              {state !== 'ok' && (
                <div className="moved">
                  {state === 'moved' ? '書いたあとに行が変わりました' : 'いまの差分にこの行が見当たりません'}（このままでは送れません）{' '}
                  <button type="button" className="linkish" onClick={() => onRemoveComment(c.id)}>外す</button>{' '}
                  <button
                    type="button"
                    className="linkish"
                    onClick={() => {
                      onBody(moveToBody(body, c))
                      onRemoveComment(c.id)
                    }}
                  >
                    全体のコメントに移す
                  </button>
                </div>
              )}
            </div>
          ))}
        </div>
        {error && <div className="err">{error}</div>}
        {blocked && !error && <div className="note">{blocked}</div>}
        <div className="actions">
          <button type="button" className={event === 'COMMENT' ? 'primary' : 'primary strong'} disabled={Boolean(blocked) || busy} onClick={send}>
            {busy ? '送っています…' : `GitHub に送る（${REVIEW_EVENT_LABEL[event]}）`}
          </button>
          <button type="button" className="linkish" disabled={busy} onClick={onClose}>やめる</button>
        </div>
      </div>
    </div>
  )
}
