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
 * 描画中に合わせる（effect の中で setState しない）。
 * `add` / `remove` / `clear` は id が変わらない限り同じ関数（関数型の setState で、いまの一覧に依らない。#611。毎回変わると、
 * 1 件足すたびに差分ビューアの全ファイルの memo が外れて描き直っていた）。**保存は updater の中で同期に**（`useLocalState` と同じ流儀。
 * effect に遅らせると、狭い画面の「入力欄に入れる」のように `clear()` と同じバッチでモーダルが閉じる（アンマウントされる fiber の更新は
 * 捨てられる）とき保存が走らず、入れたはずのコメントが下書きとして残る。#617 のレビュー）
 */
export function useDiffComments(id: string) {
  const [state, setState] = useState<{ id: string; list: DiffComment[] }>(() => ({ id, list: load()[id] ?? [] }))
  let list = state.list
  if (state.id !== id) {
    list = load()[id] ?? []
    setState({ id, list })
  }
  const update = useCallback(
    (f: (prev: DiffComment[]) => DiffComment[]) =>
      setState((prev) => {
        const next = f(prev.id === id ? prev.list : (load()[id] ?? []))
        save(withDiffComments(load(), id, next))
        return { id, list: next }
      }),
    [id],
  )
  const add = useCallback((comment: Omit<DiffComment, 'id'>) => update((prev) => [...prev, { ...comment, id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}` }]), [update])
  const remove = useCallback((commentId: string) => update((prev) => prev.filter((c) => c.id !== commentId)), [update])
  const clear = useCallback(() => update(() => []), [update])
  return { list, add, remove, clear }
}
