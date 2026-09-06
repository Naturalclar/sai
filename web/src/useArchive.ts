import { useState } from 'react'
import { api } from './api'

export interface ArchiveHandle {
  /** いま画面に出す状態（押した直後は先に反転している） */
  shown: boolean
  busy: boolean
  error: string
  toggle: () => Promise<void>
}

/**
 * アーカイブ / 戻す。PUT /api/sessions/<id>/meta に archived_at を載せるだけ（戻すは空文字で消す）。
 * 押した直後は表示を先に反転し（shown）、rev が変わって次のポーリングで本物が届く。
 * チャット見出し（ArchiveButton）とサイドバーの項目（SessionItem。アイコンとスワイプのレールが同じものを使う）が共用する。
 * 本物（archived）が変わったら反転は捨てる（呼び出し側が key で作り直さなくてよい）
 */
export function useArchive(id: string, archived: boolean): ArchiveHandle {
  const [busy, setBusy] = useState(false)
  const [flipped, setFlipped] = useState(false)
  const [error, setError] = useState('')
  const [seen, setSeen] = useState(archived)
  if (seen !== archived) {
    setSeen(archived)
    setFlipped(false)
  }
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
