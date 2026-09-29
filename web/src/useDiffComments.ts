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
 * 読むのは作ったときの 1 回だけ（差分ビューアはセッションごとに作り直される）
 */
export function useDiffComments(id: string) {
  const [list, setList] = useState<DiffComment[]>(() => load()[id] ?? [])
  const put = useCallback(
    (next: DiffComment[]) => {
      setList(next)
      save(withDiffComments(load(), id, next))
    },
    [id],
  )
  const add = useCallback((comment: Omit<DiffComment, 'id'>) => put([...list, { ...comment, id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}` }]), [list, put])
  const remove = useCallback((commentId: string) => put(list.filter((c) => c.id !== commentId)), [list, put])
  const clear = useCallback(() => put([]), [put])
  return { list, add, remove, clear }
}
