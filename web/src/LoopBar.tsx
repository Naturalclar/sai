import { useState } from 'react'
import { api, type Loop } from './api'
import { loopLive, loopStatusLine } from '../../shared/loops.ts'

interface Props {
  /** このセッションのエンティティID */
  id: string
  loop: Loop
  /** 時刻の基準（ポーリングの updatedAt） */
  now: number
}

/**
 * このセッションに組んであるループのようす（#634）。何周目か・次に起こす時刻・前の周の申し送り・止まった理由を出し、
 * 止める・再開する・いま起こす・片付けるができる。**止めても回っている周のターンは止まらない**（次の周を起こさないだけ）
 */
export function LoopBar({ id, loop, now }: Props) {
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
  const live = loopLive(loop.status)
  return (
    <div className={`agent-activity loop-bar ${loop.status}`}>
      <div className="head">
        <span className="title">{loopStatusLine(loop, now)}</span>
        <span className="actions">
          {loop.status === 'running' && !loop.turning && (
            <button type="button" disabled={busy} onClick={() => void act(() => api.loopAction(id, 'wake'))} title="次の時刻を待たずに、いま次の周を起こす">
              いま起こす
            </button>
          )}
          {loop.status === 'paused' && (
            <button type="button" disabled={busy} onClick={() => void act(() => api.loopAction(id, 'resume'))} title="一時停止したループを続ける">
              再開
            </button>
          )}
          {live ? (
            <button type="button" disabled={busy} onClick={() => void act(() => api.loopAction(id, 'stop'))} title="次の周を起こさない（回っている周のターンは止まらない）">
              止める
            </button>
          ) : (
            <button type="button" disabled={busy} onClick={() => void act(() => api.clearLoop(id))} title="この表示を消す（記録は残る）">
              片付ける
            </button>
          )}
        </span>
      </div>
      <dl className="loop-fields">
        <dt>目的</dt>
        <dd>{loop.goal}</dd>
        <dt>終わりの条件</dt>
        <dd>{loop.until}</dd>
        {loop.note && (
          <>
            <dt>申し送り</dt>
            <dd>{loop.note}</dd>
          </>
        )}
        {loop.reason && (
          <>
            <dt>{loop.status === 'done' ? '根拠' : '理由'}</dt>
            <dd className="reason">{loop.reason}</dd>
          </>
        )}
      </dl>
      {error && <div className="err">{error}</div>}
    </div>
  )
}
