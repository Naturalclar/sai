import { useCallback, useEffect, useState } from 'react'
import { api, type PersonaId, type SettingsRequest, type SettingsResponse } from './api'

/**
 * サーバ側の設定（一言の入切・口・モデル・性格、Linear の workspace）。起動時に 1 回取り、変えたら PUT して返ってきた値で置き換える。
 * ポーリングはしない（自分しか変えない）
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

  /** 省略したキーは据え置き */
  const update = useCallback(async (patch: SettingsRequest) => {
    setBusy(true)
    setError('')
    try {
      setSettings(await api.setSettings(patch))
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }, [])

  const setPersona = useCallback((persona: PersonaId) => update({ persona }), [update])
  const setLinearWorkspace = useCallback((linear_workspace: string) => update({ linear_workspace }), [update])

  return { settings, busy, error, update, setPersona, setLinearWorkspace }
}
