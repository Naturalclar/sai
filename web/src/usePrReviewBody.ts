import { useCallback, useState } from 'react'
import { parseReviewBodies, withReviewBody } from './prReviewDraft'

const KEY = 'sai.prReviewBody'

function load() {
  try {
    return parseReviewBodies(localStorage.getItem(KEY))
  } catch {
    return {}
  }
}

/**
 * GitHub に投稿するレビューの全体のコメント（#526）。書いたらすぐ localStorage に残す（閉じても、再読み込みしても消えない）。
 * 鍵が変わったら読み直す（`useDiffComments` と同じく描画中に合わせる）
 */
export function usePrReviewBody(key: string): [string, (body: string) => void] {
  const [state, setState] = useState(() => ({ key, body: load()[key]?.body ?? '' }))
  let body = state.body
  if (state.key !== key) {
    body = load()[key]?.body ?? ''
    setState({ key, body })
  }
  const set = useCallback(
    (next: string) => {
      setState({ key, body: next })
      try {
        const all = withReviewBody(load(), key, next, Date.now())
        if (Object.keys(all).length === 0) localStorage.removeItem(KEY)
        else localStorage.setItem(KEY, JSON.stringify(all))
      } catch {
        // 書けなくても画面の中では残る
      }
    },
    [key],
  )
  return [body, set]
}
