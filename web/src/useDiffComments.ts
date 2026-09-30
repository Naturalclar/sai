import { useCallback, useState } from 'react'
import { parseDiffComments, withDiffComments, type DiffComment } from './diffComments'

/** 差分へのコメントの下書き（#511）の置き場。セッション ID → コメント */
const KEY = 'sai.diffComments'

function load(): Record<string, DiffComment[]> {
  try {
    return parseDiffComments(localStorage.getItem(KEY))
  } catch {
    return {}
  }
}

function save(all: Record<string, DiffComment[]>): void {
  try {
    if (Object.keys(all).length === 0) localStorage.removeItem(KEY)
    else localStorage.setItem(KEY, JSON.stringify(all))
  } catch {
    // 書けなくても画面の中では残る（閉じたら消える）
  }
}

/**
 * そのセッションの差分へのコメント（#511）。書いたらすぐ localStorage に残す（差分ビューアを閉じても、再読み込みしても消えない）。
 * **id が変わったら読み直す**（#512 のレビュー。フィードから開いた差分ビューアは別のセッションのボタンを押しても作り直されず、
 * 前のセッションのコメントを持ったまま次のセッションに書いていた。呼ぶ側も `key` で作り直すが、ここでも持ち越さない）。
 * 描画中に合わせる（effect の中で setState しない）
 */
export function useDiffComments(id: string) {
  const [state, setState] = useState<{ id: string; list: DiffComment[] }>(() => ({ id, list: load()[id] ?? [] }))
  let list = state.list
  if (state.id !== id) {
    list = load()[id] ?? []
    setState({ id, list })
  }
  const put = useCallback(
    (next: DiffComment[]) => {
      setState({ id, list: next })
      save(withDiffComments(load(), id, next))
    },
    [id],
  )
  const add = useCallback((comment: Omit<DiffComment, 'id'>) => put([...list, { ...comment, id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}` }]), [list, put])
  const remove = useCallback((commentId: string) => put(list.filter((c) => c.id !== commentId)), [list, put])
  const clear = useCallback(() => put([]), [put])
  return { list, add, remove, clear }
}
