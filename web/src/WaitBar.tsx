import { useState } from 'react'
import { api, type Wait } from './api'
import { waitLive, waitStatusLine, waitWakeable } from '../../shared/waits.ts'

interface Props {
  /** このセッションのエンティティID */
  id: string
  wait: Wait
  /** 時刻の基準（ポーリングの updatedAt） */
  now: number
}

/**
 * このセッションが預けた待ち 1 件（#732。「PR の CI が終わったら起こして」）。何を待っているか・終わったのにまだ起こしていない理由を出し、
 * 止める・いま起こすができる。待ち始めてから長く経って終わった待ち（`late`）は自動では起きないので、ここの「いま起こす」で起こす。**いま起こすは、使用量の枠と 1 日の回数だけを越える**（処理中・前の返信の失敗は越えない）。
 * 起こせた待ちは消える（起きたターンがチャットに出る）
 */
export function WaitBar({ id, wait, now }: Props) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const act = async (work: () => Promise<unknown>) => {
    setBusy(true)
    setError('')
    try {
      await work()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }
  const live = waitLive(wait.status)
  return (
    <div className={`agent-activity loop-bar wait-bar ${wait.status}`}>
      <div className="head">
        <span className="title">{waitStatusLine(wait, now)}</span>
        <span className="actions">
          {waitWakeable(wait.status) && (
            <button
              type="button"
              disabled={busy}
              onClick={() => void act(() => api.waitAction(id, wait.id, 'wake'))}
              title={wait.status === 'waiting' ? 'CI が終わるのを待たずに、いまこのセッションを起こす（文脈を読み直すのでトークンを使う）' : wait.late ? '結果を渡して、いまこのセッションを起こす（キャッシュが切れているので、文脈を読み直す。大きければ要約してから）' : '使用量の枠・1 日の回数に関係なく、いまこのセッションを起こす（文脈を読み直すのでトークンを使う）'}
            >
              いま起こす
            </button>
          )}
          <button type="button" disabled={busy} onClick={() => void act(() => api.waitAction(id, wait.id, 'stop'))} title={live ? 'この待ちをやめる（起こさない）' : 'この表示を消す'}>
            {live ? '止める' : '片付ける'}
          </button>
        </span>
      </div>
      <dl className="loop-fields">
        <dt>起きたら</dt>
        <dd>{wait.then}</dd>
        {wait.reason && (
          <>
            <dt>理由</dt>
            <dd className="reason">{wait.reason}</dd>
          </>
        )}
      </dl>
      {error && <div className="err">{error}</div>}
    </div>
  )
}
