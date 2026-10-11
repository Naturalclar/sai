import { useState } from 'react'
import { api } from './api'

/**
 * 待ち 1 件を「いま起こす」「止める・片付ける」（#732）。帯（`WaitBar`）と要対応の行（`TodoWaitRow`）が同じ口を叩く。
 * 起こせた・止めた待ちは次のポーリングで消える。断られた理由はそのまま出す（1 つの待ちで起こすのは 1 回で、決めるのはサーバ）
 */
export function useWaitAction(id: string, waitId: string) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const act = async (action: 'stop' | 'wake') => {
    setBusy(true)
    setError('')
    try {
      await api.waitAction(id, waitId, action)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }
  return { busy, error, wake: () => void act('wake'), stop: () => void act('stop') }
}
