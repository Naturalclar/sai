import { useState } from 'react'
import type { AgentRequestResult } from '../../shared/types.ts'
import { api } from './api'

interface Props {
  /** このセッション（送り元）のエンティティID */
  id: string
  /** 相手（成果を返したセッション） */
  to: string
  result: AgentRequestResult
}

/**
 * 成果を「確認済み」にする・取り消す（#903）。**SAI の上の記録だけ**で、相手のセッション・CLI の許可・GitHub（承認・マージ）には何もしない。
 * 確認はこの返答の行に紐づく（直してもらった新しい返答には付かない）。押したあとの印は次のポーリングで描き直す
 */
export function ResultCheckButton({ id, to, result }: Props) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const checked = Boolean(result.checked_at)
  const toggle = async () => {
    setBusy(true)
    setError('')
    try {
      await api.checkAgentResult(id, { to, ts: result.ts, checked: !checked })
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }
  return (
    <span className="result-check">
      <button
        type="button"
        disabled={busy}
        onClick={() => void toggle()}
        title={checked ? '確認済みの印を外して、確認待ちに戻す' : 'この成果を自分で確かめた印を付ける（SAI の上の印だけ。許可・GitHub の承認・マージはしない）'}
      >
        {checked ? '確認を取り消す' : '確認済みにする'}
      </button>
      {error && <span className="err">{error}</span>}
    </span>
  )
}
