import { useCallback, useEffect, useRef, useState } from 'react'

export const POLL_MS = 3000

export type Route = { name: 'list' } | { name: 'session'; id: string } | { name: 'feed' }

export function parseRoute(hash: string): Route {
  const m = hash.match(/^#\/s\/(.+)$/)
  if (m?.[1]) return { name: 'session', id: decodeURIComponent(m[1]) }
  if (hash === '#/feed') return { name: 'feed' }
  return { name: 'list' }
}

export function useHashRoute(): Route {
  const [route, setRoute] = useState<Route>(() => parseRoute(location.hash))
  useEffect(() => {
    const onChange = () => setRoute(parseRoute(location.hash))
    window.addEventListener('hashchange', onChange)
    return () => window.removeEventListener('hashchange', onChange)
  }, [])
  return route
}

export function useLocalState<T extends object>(key: string, fallback: T): [T, (next: Partial<T>) => void] {
  const [value, setValue] = useState<T>(() => {
    try {
      const raw = localStorage.getItem(key)
      return raw ? { ...fallback, ...(JSON.parse(raw) as Partial<T>) } : fallback
    } catch {
      return fallback
    }
  })
  const update = useCallback(
    (next: Partial<T>) => {
      setValue((prev) => {
        const merged = { ...prev, ...next }
        try {
          localStorage.setItem(key, JSON.stringify(merged))
        } catch {
          // 保存できなくても動く
        }
        return merged
      })
    },
    [key],
  )
  return [value, update]
}

export interface Polled<T> {
  data: T | null
  error: string | null
  updatedAt: Date | null
}

/**
 * 3秒ごとに fetcher を叩く。レスポンスの rev が前と同じなら state を更新しない
 * （= 再描画しない）。タブが隠れている間は止まり、戻ったら即1回叩く。
 */
export function usePolling<T extends { rev: string }>(fetcher: () => Promise<T>, deps: unknown[]): Polled<T> {
  const [state, setState] = useState<Polled<T>>({ data: null, error: null, updatedAt: null })
  const lastRev = useRef<string | null>(null)

  // deps は呼び出し側が「この値が変わったら取り直す」と決めたもの
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const load = useCallback(fetcher, deps)

  useEffect(() => {
    let alive = true
    lastRev.current = null
    setState({ data: null, error: null, updatedAt: null })

    const tick = async () => {
      if (document.hidden) return
      try {
        const next = await load()
        if (!alive) return
        if (next.rev === lastRev.current) {
          setState((s) => ({ ...s, error: null, updatedAt: new Date() }))
          return
        }
        lastRev.current = next.rev
        setState({ data: next, error: null, updatedAt: new Date() })
      } catch (err) {
        if (alive) setState((s) => ({ ...s, error: err instanceof Error ? err.message : String(err), updatedAt: new Date() }))
      }
    }

    void tick()
    const timer = setInterval(() => void tick(), POLL_MS)
    const onVisible = () => {
      if (!document.hidden) void tick()
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      alive = false
      clearInterval(timer)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [load])

  return state
}
