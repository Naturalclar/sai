import { useEffect, useState } from 'react'
import { api, type SessionProgressResponse } from './api'

/** 取り直す間隔。一覧のポーリングと同じ 3 秒 */
export const PROGRESS_POLL_MS = 3000

/**
 * 処理中のターンの手順（#302）。**処理中のセッションを出している間だけ**、そのセッションの分を 3 秒おきに取る
 * （一覧のポーリングには載せない。transcript を読むので、全セッションぶんを毎回は読まない）。
 * タブが隠れている間は取らない。rev が同じなら state を触らない。取れなければ null（手順が出ないだけで、「処理中」はそのまま）
 */
export function useProgress(id: string, enabled: boolean): SessionProgressResponse | null {
  const [loaded, setLoaded] = useState<{ key: string; data: SessionProgressResponse } | null>(null)
  const key = enabled ? id : ''

  useEffect(() => {
    if (!key) return
    let alive = true
    let rev = ''
    const tick = async () => {
      if (document.hidden) return
      try {
        const data = await api.progress(key)
        if (!alive || data.rev === rev) return
        rev = data.rev
        setLoaded({ key, data })
      } catch {
        // 読めない（セッションが窓から落ちた、サーバが止まっている）。手順が出ないだけ
      }
    }
    void tick()
    const timer = setInterval(() => void tick(), PROGRESS_POLL_MS)
    return () => {
      alive = false
      clearInterval(timer)
    }
  }, [key])

  // 別のセッションに移ったら、前のセッションの手順は出さない
  return loaded && loaded.key === key ? loaded.data : null
}
