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
 * 確認はこの返答の行に紐づく（直してもらった新しい返答には付かない）。押して通ったら、ボタンの語は次のポーリングを待たずに変える
 * （`done` は押したときの成果の `ts` と `checked_at` を覚え、ポーリングでどちらかが変われば捨てて props の方に戻る。描画中に捨てる。effect は使わない）
 */
export function ResultCheckButton({ id, to, result }: Props) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [done, setDone] = useState<{ ts: string; was: string | undefined; checked: boolean } | null>(null)
  const fresh = done !== null && done.ts === result.ts && done.was === result.checked_at
  // 一度でも props が追いついた（変わった）ら捨てる。あとで同じ値に戻っても、古い押した結果を出さない
  if (done !== null && !fresh) setDone(null)
  const checked = fresh ? done.checked : Boolean(result.checked_at)
  const toggle = async () => {
    setBusy(true)
    setError('')
    try {
      const { ts, checked_at: was } = result
      await api.checkAgentResult(id, { to, ts, checked: !checked })
      setDone({ ts, was, checked: !checked })
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
