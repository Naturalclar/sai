import { useEffect, useRef } from 'react'
import type { Replying } from '../../shared/types.ts'
import { api } from './api'
import { sessionHash, usePolling } from './hooks'
import { startStatus } from './newSession'

interface Props {
  /** 始めたセッションのエンティティID */
  id: string
  /** 送った最初の指示 */
  text: string
  /** 送った時刻（ms） */
  since: number
  /** 一覧の `replying[id]`。行が届く前に落ちたら `failed` が載る */
  replying: Replying | undefined
  /** 一覧を取った時刻（ms） */
  now: number
  /** 失敗したとき、書き直しに戻る */
  onRetry: () => void
  /** `claude --bg` で始めたときの短い ID（#462） */
  attach?: string
  /**
   * 最初の行が届いたとき（新しいセッションのペイン: App がそのペインをそのセッションに入れ替える）。
   * 渡されなければ、そのセッションの画面へ移るだけ（セッションの画面の「引き継いで新しいセッション」）
   */
  onArrived?: (id: string) => void
}

/**
 * 始めたセッションの最初の行を待ち、届いたらそのセッションの画面へ移る（#314）。
 * 詳細（`GET /api/sessions/<id>`）は行が届くまで 404 なので、**ここで待ってから移る**（先に移ると SessionView がエラーを出すだけ）
 */
export function NewSessionStarting({ id, text, since, replying, now, onRetry, attach, onArrived }: Props) {
  const { data } = usePolling(() => api.session(id), [id])
  const status = startStatus(data !== null, replying, since, now)
  const arrived = status.kind === 'arrived'
  // 届いたら 1 回だけ（`onArrived` は並びが変わるたびに作り直されるので、依存に入れずに ref で持つ）
  const arrive = useRef(onArrived)
  useEffect(() => {
    arrive.current = onArrived
  })
  useEffect(() => {
    if (!arrived) return
    if (arrive.current) arrive.current(id)
    else location.hash = sessionHash(id)
  }, [arrived, id])

  return (
    <div className="new-session starting">
      <p className="quoted">{text}</p>
      {status.kind === 'running' && <div className="note">開始中… 最初の記録が届いたら、このセッションの画面に移ります</div>}
      {status.kind === 'arrived' && <div className="note">移動しています…</div>}
      {attach && (
        <div className="note">
          バックグラウンドで始めました。端末で開くなら <code>claude attach {attach}</code>
        </div>
      )}
      {status.kind === 'failed' && (
        <>
          <div className="notice error">始められませんでした: {status.message}</div>
          <div className="actions">
            <button type="button" onClick={onRetry}>書き直す</button>
          </div>
        </>
      )}
      {status.kind === 'silent' && (
        <div className="notice">
          CLI は終わりましたが、記録が届いていません。フックの向け先を確かめてください（<code>/setup-sai</code>）。<a href={sessionHash(id)}>このセッションを開いてみる</a>
        </div>
      )}
    </div>
  )
}
