import { useEffect, useState } from 'react'
import { api, type SearchHit } from './api'

/** 打ち終わりを待つ時間。⌘K のセッション名の絞り込みは手元なので即出る（そちらは待たせない） */
export const SEARCH_DEBOUNCE_MS = 250
/** これより短い検索語では叩かない（1 文字で全部に当たってもうれしくない） */
export const MIN_QUERY_LENGTH = 2

export interface SearchState {
  hits: SearchHit[]
  /** 問い合わせ中（打ち終わり待ちを含む） */
  busy: boolean
  /** 上限で切った */
  truncated: boolean
  /** 舐めた行数。0 件のときに範囲を伝える */
  scanned: number
  error: string
}

/** 届いた結果と、それがどの検索語のものか。**打っている間に古い結果を出さない**ための鍵 */
interface Landed {
  q: string
  hits: SearchHit[]
  truncated: boolean
  scanned: number
  error: string
}

const NOTHING: SearchHit[] = []

/**
 * 発言の本文の検索（#230）。**打ち終わってから**サーバに聞く（`SEARCH_DEBOUNCE_MS`）。
 *
 * ⌘K のセッション名の絞り込みは開いたときの一覧を手元で filter するので打つたびに即応する。
 * その気持ちよさを壊さないように、こちらだけ遅らせて、返ってきたら下に足す形にしてある。
 *
 * **状態は「届いた結果」だけ持ち、「探し中か」は描画中に導く**（effect の中で同期に setState しない。
 * oxlint の `react/set-state-in-effect` が止める。App.tsx の `focusLater` と同じ考え方）。
 * 打ち直しで前の応答が後から届いても、`alive` と `q` の突き合わせの二重で捨てる
 */
export function useSearch(query: string, days = 90): SearchState {
  const [landed, setLanded] = useState<Landed | null>(null)
  const q = query.trim()
  const wanted = q.length >= MIN_QUERY_LENGTH

  useEffect(() => {
    if (!wanted) return
    let alive = true
    const timer = setTimeout(() => {
      void api.search(q, days).then(
        (res) => alive && setLanded({ q, hits: res.hits, truncated: res.truncated, scanned: res.scanned, error: '' }),
        (err: unknown) => alive && setLanded({ q, hits: [], truncated: false, scanned: 0, error: err instanceof Error ? err.message : String(err) }),
      )
    }, SEARCH_DEBOUNCE_MS)
    return () => {
      alive = false
      clearTimeout(timer)
    }
  }, [q, days, wanted])

  // いまの検索語の結果が届いていればそれ。まだなら「探し中」（前の検索語の結果は出さない）
  if (!wanted) return { hits: NOTHING, busy: false, truncated: false, scanned: 0, error: '' }
  if (!landed || landed.q !== q) return { hits: NOTHING, busy: true, truncated: false, scanned: 0, error: '' }
  return { hits: landed.hits, busy: false, truncated: landed.truncated, scanned: landed.scanned, error: landed.error }
}
