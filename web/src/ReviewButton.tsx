import { useState } from 'react'
import type { ReviewTarget } from '../../shared/types.ts'
import { api } from './api'

/**
 * 差分ビューアの見出しから、その差分を Codex にレビューさせる（#403）。
 * 結果は普通のターンとしてチャットに届くので、ここは頼むところまで（押したら「頼みました」に変わる）。
 * Codex のセッションで、いま返信できるときだけ親（`DiffBody`）が出す
 */
export function ReviewButton({ id, target }: { id: string; target: ReviewTarget }) {
  const [state, setState] = useState<'idle' | 'sending' | 'sent'>('idle')
  const [error, setError] = useState('')

  const send = () => {
    setState('sending')
    setError('')
    api
      .review(id, target)
      .then(() => setState('sent'))
      .catch((err: unknown) => {
        setState('idle')
        setError(err instanceof Error ? err.message : String(err))
      })
  }

  return (
    <span className="review">
      <button type="button" className="review-btn" onClick={send} disabled={state !== 'idle'} title="この差分を Codex にレビューさせる">
        {state === 'sending' ? '頼んでいます…' : state === 'sent' ? '頼みました' : 'レビューさせる'}
      </button>
      {error && <span className="err">{error}</span>}
    </span>
  )
}
