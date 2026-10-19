import { useState } from 'react'
import { api } from './api'

interface Props {
  /** このセッション（送り元）のエンティティID */
  id: string
  stopped: boolean
}

/**
 * 「送信を止める」「再開する」（#311）。枠（`AgentActivityBar`）の見出しと、枠を出していないときのチャット見出しの操作（#823。
 * 狭い画面では `⋯` のパネル）の両方がこれを使う（止める口を無くさない）。止めると、このセッションから送られて預かりに並んでいた分も
 * 取り消す（相手でもう回っているターンは止めない）
 */
export function AgentStopButton({ id, stopped }: Props) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const toggle = async () => {
    setBusy(true)
    setError('')
    try {
      await (stopped ? api.resumeAgent(id) : api.stopAgent(id))
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }
  return (
    <span className="agent-stop">
      <button
        type="button"
        disabled={busy}
        onClick={() => void toggle()}
        title={
          stopped
            ? 'このセッションから別のセッションへ、また送れるようにする'
            : 'このセッションから別のセッションへ送るのを止める。預かりに並んでいる分・まだ送っていない預かりも取り消す（相手でもう回っているターンは止まらない）'
        }
      >
        {stopped ? '送信を再開する' : '送信を止める'}
      </button>
      {error && <span className="err">{error}</span>}
    </span>
  )
}
