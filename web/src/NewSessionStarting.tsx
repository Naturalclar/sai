import { useEffect } from 'react'
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
}

/**
 * 始めたセッションの最初の行を待ち、届いたらそのセッションの画面へ移る（#314）。
 * 詳細（`GET /api/sessions/<id>`）は行が届くまで 404 なので、**ここで待ってから移る**（先に移ると SessionView がエラーを出すだけ）
 */
export function NewSessionStarting({ id, text, since, replying, now, onRetry }: Props) {
  const { data } = usePolling(() => api.session(id), [id])
  const status = startStatus(data !== null, replying, since, now)
  const arrived = status.kind === 'arrived'
  useEffect(() => {
    if (arrived) location.hash = sessionHash(id)
  }, [arrived, id])

  return (
    <div className="new-session starting">
      <p className="quoted">{text}</p>
      {status.kind === 'running' && <div className="note">開始中… 最初の記録が届いたら、このセッションの画面に移ります</div>}
      {status.kind === 'arrived' && <div className="note">移動しています…</div>}
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
