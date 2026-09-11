import { useCallback, useEffect, useRef, useState } from 'react'

export const POLL_MS = 3000

export type Route =
  | { name: 'list' }
  /** `ts` は検索から飛んできたとき（#230）。その発言まで送って光らせる */
  | { name: 'session'; id: string; ts?: string }
  | { name: 'feed' }
  | { name: 'todo' }
  /** 新しいセッションを始める（#314） */
  | { name: 'new' }

export function parseRoute(hash: string): Route {
  // id は encodeURIComponent 済みなので `?` は含まれない（%3F になる）。後ろが検索から来た ts
  const m = hash.match(/^#\/s\/([^?]+)(?:\?(.*))?$/)
  if (m?.[1]) {
    let id: string
    try {
      id = decodeURIComponent(m[1])
    } catch {
      id = m[1] // 壊れた %-エンコードでも「そのセッションが無い」に落とす（画面を白くしない）
    }
    const ts = new URLSearchParams(m[2] ?? '').get('ts')
    return ts ? { name: 'session', id, ts } : { name: 'session', id }
  }
  if (hash === '#/feed') return { name: 'feed' }
  // 要対応（#224）。いま自分を待っているものだけ
  if (hash === '#/todo') return { name: 'todo' }
  if (hash === '#/new') return { name: 'new' }
  return { name: 'list' }
}

/** 検索の当たりへ飛ぶ hash（#230）。`ts` が無ければ普通のセッションの hash */
export function sessionHash(id: string, ts = ''): string {
  const base = `#/s/${encodeURIComponent(id)}`
  return ts ? `${base}?ts=${encodeURIComponent(ts)}` : base
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

/** タブが裏にある間の間隔（#231）。表の 3 秒より大きく空ける */
export const HIDDEN_POLL_MS = 20000

export interface PollOptions {
  /**
   * タブが隠れている間も、この間隔で叩き続ける（省略すると隠れている間は止まる）。
   * **一覧だけに付ける。** 裏に回っている間に「あなたを待っています」が増えたことを、
   * タブの題名と通知で伝えるため（#231）。チャットやフィードは見ていないので止めたままでよい
   */
  hiddenMs?: number
}

/**
 * 3秒ごとに fetcher を叩く。レスポンスの rev が前と同じなら state を更新しない（= 再描画しない）。
 * タブが隠れている間は止まり、戻ったら即1回叩く。
 * **`hiddenMs` を渡したときだけ**、隠れている間もその間隔で叩き続ける。
 */
export function usePolling<T extends { rev: string }>(fetcher: () => Promise<T>, deps: unknown[], options: PollOptions = {}): Polled<T> {
  const [state, setState] = useState<Polled<T>>({ data: null, error: null, updatedAt: null })
  const lastRev = useRef<string | null>(null)
  const { hiddenMs } = options

  // deps は呼び出し側が「この値が変わったら取り直す」と決めたもの
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const load = useCallback(fetcher, deps)

  useEffect(() => {
    let alive = true
    lastRev.current = null
    setState({ data: null, error: null, updatedAt: null })

    const tick = async () => {
      if (document.hidden && !hiddenMs) return
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

    // 表と裏で間隔が違うので、切り替わるたびにタイマーを張り直す
    let timer: ReturnType<typeof setInterval> | undefined
    const arm = () => {
      clearInterval(timer)
      const ms = document.hidden ? hiddenMs : POLL_MS
      if (ms) timer = setInterval(() => void tick(), ms)
    }

    void tick()
    arm()
    const onVisible = () => {
      arm()
      // 表に戻ったら待たずに 1 回。裏へ回ったときは次の周期でよい
      if (!document.hidden) void tick()
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      alive = false
      clearInterval(timer)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [load, hiddenMs])

  return state
}

/**
 * メディアクエリが当たるか。最初の描画では false で、effect で本当の値に更新し、以後は変化に追従する
 * （描画中に matchMedia を呼ばない）
 */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(false)
  useEffect(() => {
    const mq = window.matchMedia(query)
    const update = () => setMatches(mq.matches)
    update()
    mq.addEventListener('change', update)
    return () => mq.removeEventListener('change', update)
  }, [query])
  return matches
}
