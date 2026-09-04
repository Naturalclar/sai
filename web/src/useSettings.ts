import { useCallback, useEffect, useState } from 'react'
import { api, type PersonaId, type SettingsResponse } from './api'

/**
 * サーバ側の設定（一言の性格）。起動時に 1 回取り、変えたら PUT して返ってきた値で置き換える。
 * ポーリングはしない（性格は自分しか変えない）
 */
export function useSettings() {
  const [settings, setSettings] = useState<SettingsResponse | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    let alive = true
    api
      .settings()
      .then((s) => alive && setSettings(s))
      .catch((err) => alive && setError(err instanceof Error ? err.message : String(err)))
    return () => {
      alive = false
    }
  }, [])

  const setPersona = useCallback(async (persona: PersonaId) => {
    setBusy(true)
    setError('')
    try {
      setSettings(await api.setSettings({ persona }))
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }, [])

  return { settings, busy, error, setPersona }
}
