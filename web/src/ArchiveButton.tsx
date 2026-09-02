import { useState } from 'react'
import { api } from './api'

/**
 * チャット見出しの「アーカイブ」/「戻す」。PUT /api/sessions/<id>/meta に archived_at を載せるだけ
 * （戻すは空文字で消す）。押した直後は表示を先に反転し、rev が変わって次のポーリングで本物が届く。
 * 呼び出し側は key に archived を含めること（届いたら作り直して反転を捨てる）
 */
export function ArchiveButton({ id, archived }: { id: string; archived: boolean }) {
  const [busy, setBusy] = useState(false)
  const [flipped, setFlipped] = useState(false)
  const [error, setError] = useState('')
  const shown = flipped ? !archived : archived

  const toggle = async () => {
    setBusy(true)
    setError('')
    try {
      await api.setMeta(id, { archived_at: shown ? '' : new Date().toISOString() })
      setFlipped((v) => !v)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <span className="meta archive">
      <button type="button" className="linkish" onClick={() => void toggle()} disabled={busy} title={shown ? 'アーカイブを解除して一覧に戻す' : '一覧とフィードから隠す（新しい行が届くと自動で戻る）'}>
        {busy ? '…' : shown ? '戻す' : 'アーカイブ'}
      </button>
      {error && <span className="err">{error}</span>}
    </span>
  )
}
