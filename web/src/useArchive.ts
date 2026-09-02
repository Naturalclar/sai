import { useState } from 'react'
import { api } from './api'

/**
 * アーカイブ / 戻す。PUT /api/sessions/<id>/meta に archived_at を載せるだけ（戻すは空文字で消す）。
 * 押した直後は表示を先に反転し（shown）、rev が変わって次のポーリングで本物が届く。
 * チャット見出し（ArchiveButton）とサイドバーの項目（SessionArchiveButton）が共用する。
 * 呼び出し側は key に archived を含めること（届いたら作り直して反転を捨てる）
 */
export function useArchive(id: string, archived: boolean) {
  const [busy, setBusy] = useState(false)
  const [flipped, setFlipped] = useState(false)
  const [error, setError] = useState('')
  const shown = flipped ? !archived : archived

  const toggle = async () => {
    if (busy) return
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

  return { shown, busy, error, toggle }
}

export const ARCHIVE_TITLE = '一覧とフィードから隠す（新しい行が届くと自動で戻る）'
export const RESTORE_TITLE = 'アーカイブを解除して一覧に戻す'
