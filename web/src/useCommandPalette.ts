import { useCallback, useEffect, useState } from 'react'
import { api, type SessionSummary } from './api'

/**
 * ⌘K（Ctrl+K）の開閉と、開いたときに取り直す一覧。
 *
 * サイドバーの一覧は絞り込みが効いた後（既定でアーカイブ済みを除き、`days` の窓も効く）なので、
 * それだけだと「絞り込んだせいで見つからない」が起きる。開いたときに**絞り込み無しで 1 回だけ**取り直す
 * （3 秒のポーリングには乗せない。`useSkills` / `DiffButton` と同じ）。取れるまでは呼び出し側が持っている
 * 一覧をそのまま出す（すぐ何か出る方がよい）
 */
export function useCommandPalette() {
  const [open, setOpen] = useState(false)
  const [all, setAll] = useState<SessionSummary[] | null>(null)

  // ⌘K / Ctrl+K。入力欄にフォーカスがあっても効く（⌘\ と同じ）。IME 変換中は無視。
  // Firefox の ⌘K（検索バー）を取るので preventDefault する
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'k' && e.key !== 'K') return
      if (!(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey || e.isComposing) return
      e.preventDefault()
      setOpen((v) => !v)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  // 開いたときだけ取り直す。閉じている間は何もしない
  useEffect(() => {
    if (!open) return
    let alive = true
    void api
      .sessions({ project: '', repo: '', agent: '', date: '', host: '', days: '90', archived: '' })
      .then((res) => {
        if (alive) setAll(res.sessions)
      })
      .catch(() => {
        // 取れなければ呼び出し側の一覧のまま。開けないよりはよい
      })
    return () => {
      alive = false
    }
  }, [open])

  const close = useCallback(() => setOpen(false), [])
  return { open, close, all }
}
