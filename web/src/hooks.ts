import { useCallback, useEffect, useRef, useState } from 'react'

export const POLL_MS = 3000

export type Route =
  | { name: 'list' }
  /**
   * `ts` は検索から飛んできたとき（#230）と、発言へのリンク（#503）。その発言まで送って光らせる。
   * `side` はどちら側か（1 本の行から自分の入力と返答が**同じ ts** で 2 つ出るので、どちらかを名指しする）。無ければどちらでも
   */
  | { name: 'session'; id: string; ts?: string; side?: MessageSide }
  | { name: 'feed' }
  | { name: 'todo' }
  /** 新しいセッションを始める（#314） */
  | { name: 'new' }
  /** GitHub に出ている PR の一覧（#524） */
  | { name: 'prs' }
  /** 使用量の画面（#602） */
  | { name: 'usage' }
  /** PR 1 本（#524）。`repo` は `owner/repo` */
  | { name: 'pr'; repo: string; number: number }

/** 発言のどちら側か（#503）。`me` = 自分の入力、`agent` = エージェントの発言 */
export type MessageSide = 'me' | 'agent'

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
    const q = new URLSearchParams(m[2] ?? '')
    const ts = q.get('ts')
    if (!ts) return { name: 'session', id }
    // 知らない値は付けない（検索の飛び先と同じ「どちらでも最初に見つかった方」に落ちる）
    const side = q.get('side')
    return side === 'me' || side === 'agent' ? { name: 'session', id, ts, side } : { name: 'session', id, ts }
  }
  if (hash === '#/feed') return { name: 'feed' }
  // 要対応（#224）。いま自分を待っているものだけ
  if (hash === '#/todo') return { name: 'todo' }
  if (hash === '#/new') return { name: 'new' }
  if (hash === '#/usage') return { name: 'usage' }
  // GitHub の PR（#524）。1 本は `#/pr/<owner>/<repo>/<番号>`（番号は数字だけ。壊れていれば一覧へ）
  if (hash === '#/prs') return { name: 'prs' }
  const pr = hash.match(/^#\/pr\/([^/?#]+)\/([^/?#]+)\/([1-9][0-9]{0,8})$/)
  if (pr) {
    try {
      return { name: 'pr', repo: `${decodeURIComponent(pr[1]!)}/${decodeURIComponent(pr[2]!)}`, number: Number(pr[3]) }
    } catch {
      return { name: 'prs' }
    }
  }
  if (hash.startsWith('#/pr/')) return { name: 'prs' }
  return { name: 'list' }
}

/**
 * 検索の当たり（#230）・発言へのリンク（#503）へ飛ぶ hash。`ts` が無ければ普通のセッションの hash。
 * `side` を省くと、その ts のどちらでも先に見つかった方に着く（`side` を持たない古いリンクの形。検索の当たりは
 * 本文と入力のどちらで当たったか（`who`）を持っているので、#503 からは渡している）
 */
export function sessionHash(id: string, ts = '', side?: MessageSide): string {
  const base = `#/s/${encodeURIComponent(id)}`
  if (!ts) return base
  return `${base}?ts=${encodeURIComponent(ts)}${side ? `&side=${side}` : ''}`
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
  /**
   * これが変わったときだけ、取り直す前に data を空にする（省略すると deps が変わるたびに空にする）。
   * セッション画面は「前の 7 日を表示」（#477）で取り直すが、そこで空にするとチャットが作り直されて読んでいた場所を失う
   */
  resetKey?: string
}

/**
 * 3秒ごとに fetcher を叩く。レスポンスの rev が前と同じなら state を更新しない（= 再描画しない）。
 * タブが隠れている間は止まり、戻ったら即1回叩く。
 * **`hiddenMs` を渡したときだけ**、隠れている間もその間隔で叩き続ける。
 */
export function usePolling<T extends { rev: string }>(fetcher: () => Promise<T>, deps: unknown[], options: PollOptions = {}): Polled<T> {
  const [state, setState] = useState<Polled<T>>({ data: null, error: null, updatedAt: null })
  const lastRev = useRef<string | null>(null)
  const { hiddenMs, resetKey } = options
  const lastReset = useRef<string | undefined>(undefined)

  // deps は呼び出し側が「この値が変わったら取り直す」と決めたもの
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const load = useCallback(fetcher, deps)

  useEffect(() => {
    let alive = true
    lastRev.current = null
    if (resetKey === undefined || resetKey !== lastReset.current) setState({ data: null, error: null, updatedAt: null })
    lastReset.current = resetKey

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
  }, [load, hiddenMs, resetKey])

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
