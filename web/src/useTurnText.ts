import { useEffect, useState } from 'react'
import { api, type FeedRow } from './api'

export type TurnText = { state: 'loading' } | { state: 'error' } | { state: 'ok'; row: FeedRow | null }

/**
 * そのセッションの `ts` のターン完了の行（#537）。**`ts` を渡したときだけ**、1 回取る（一覧のポーリングには載せない）。
 * 同じ (id, ts) の間は取り直さない（開いている間にポーリングで描き直されても、もう一度は取らない）
 */
export function useTurnText(id: string, ts: string): TurnText {
  const [loaded, setLoaded] = useState<{ key: string; value: TurnText } | null>(null)
  const key = ts ? `${id} ${ts}` : ''

  useEffect(() => {
    if (!key || loaded?.key === key) return
    let alive = true
    void api.turn(id, ts).then(
      (data) => alive && setLoaded({ key, value: { state: 'ok', row: data.row } }),
      () => alive && setLoaded({ key, value: { state: 'error' } }),
    )
    return () => {
      alive = false
    }
  }, [id, ts, key, loaded?.key])

  return loaded && loaded.key === key ? loaded.value : LOADING
}

const LOADING: TurnText = { state: 'loading' }
