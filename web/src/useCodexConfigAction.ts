import { useState } from 'react'
import { api } from './api'

/**
 * Codex を起こす前の確かめ（#856）の「このまま起こす」「片付ける」。片付いた行は次のポーリングで消える。
 * 断られた理由（中身が変わった）はそのまま出す。決めるのはサーバ
 */
export function useCodexConfigAction(id: string, fingerprint: string) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const act = async (action: 'allow' | 'dismiss') => {
    setBusy(true)
    setError('')
    try {
      await api.codexConfig(id, action, fingerprint)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }
  return { busy, error, allow: () => void act('allow'), dismiss: () => void act('dismiss') }
}
