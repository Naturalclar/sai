import { useState } from 'react'
import { api } from './api'
import { md } from './format'
import { sessionHash } from './hooks'

interface Props {
  id: string
  /** アーカイブした時刻（`returnedFromArchive()` の返り値） */
  at: string
  /** 同じ worktree の、アーカイブのあとに始まったセッション（`newerSibling()`）。無ければリンクを出さない */
  sibling?: { id: string; name: string; start: string } | undefined
}

/**
 * 入力欄の上の 1 行（#583）。アーカイブしたセッションに返信が続いていることを知らせる。
 * 返信は止めない（確認も挟まない）。「このまま使う」は `archived_at` を消すだけで、以後は出ない。
 * 同じ worktree にもっと新しいセッションがあれば、そこへのリンクを添える
 */
export function ArchiveReturnNote({ id, at, sibling }: Props) {
  // 押してから次のポーリングで archived_at が消えるまでの間も出さない
  const [kept, setKept] = useState(false)
  const [error, setError] = useState('')
  if (kept) return null
  const keep = () => {
    setKept(true)
    api.setMeta(id, { archived_at: '' }).catch((err: unknown) => {
      setKept(false)
      setError(err instanceof Error ? err.message : String(err))
    })
  }
  return (
    <div className="notice archive-return" role="status">
      <span>{md(at)} にアーカイブしたセッションです。</span>
      <button type="button" onClick={keep}>このまま使う</button>
      {sibling && (
        <a href={sessionHash(sibling.id)}>
          {sibling.name}（{md(sibling.start)}〜）を開く
        </a>
      )}
      {error && <span className="err">{error}</span>}
    </div>
  )
}
