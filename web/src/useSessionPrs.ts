import { useEffect, useState } from 'react'
import { api } from './api'
import type { PrRepo } from '../../shared/types.ts'

/** 一覧の PR を取り直す間隔（#548）。サーバも `gh pr list` を 60 秒覚えるので、これより短くしても `gh` は増えない */
export const SESSION_PRS_MS = 60_000

const NO_REPOS: PrRepo[] = []

/**
 * サイドバーのセッションに付ける PR の材料（#548。`GET /api/prs` の open な PR）。
 * **一覧の 3 秒のポーリングには載せない**（リポジトリの数だけ `gh` が走る）。開いたときと、見えている間の 60 秒おき、
 * タブに戻ったときだけ取る。`gh` が無い・`SAI_GH=0`・取れなかったときは空（印が出ないだけ）
 */
export function useSessionPrs(): PrRepo[] {
  const [repos, setRepos] = useState<PrRepo[]>(NO_REPOS)
  useEffect(() => {
    let alive = true
    let last = 0
    const load = () => {
      if (document.hidden || Date.now() - last < SESSION_PRS_MS) return
      last = Date.now()
      api.prs().then(
        (data) => alive && setRepos(data.available ? data.repos : NO_REPOS),
        () => undefined, // 取れなければ前の結果のまま（次の 60 秒でもう一度）
      )
    }
    load()
    const timer = setInterval(load, SESSION_PRS_MS)
    const onVisible = () => load()
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      alive = false
      clearInterval(timer)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [])
  return repos
}
