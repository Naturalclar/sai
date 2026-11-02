import { useState } from 'react'
import type { KeyboardEvent } from 'react'
import type { SiblingWorktree } from '../../shared/types.ts'
import { worktreeNameRefusal } from '../../shared/worktreeName.ts'
import { api } from './api'

interface Props {
  /** どのリポジトリに作るか（選んでいる worktree の `from`）。パスは送らない */
  from: string
  project: string
  disabled: boolean
  onAdded: (sibling: SiblingWorktree) => void
}

/**
 * 新しいセッションの画面から worktree を作る（#847）。名前だけを送り、置き場とリポジトリはサーバが `from` の cwd から決める。
 * 作るだけでセッションは始めない（できたものが選ばれた状態になり、最初の指示を書いて始める）
 */
export function NewWorktreeForm({ from, project, disabled, onAdded }: Props) {
  const [open, setOpen] = useState(false)
  const [name, setName] = useState('')
  const [adding, setAdding] = useState(false)
  const [error, setError] = useState('')
  const trimmed = name.trim()
  const refusal = trimmed ? worktreeNameRefusal(trimmed) : ''

  if (!open) {
    return (
      <div className="new-worktree">
        <button type="button" className="open" disabled={disabled} onClick={() => setOpen(true)}>
          ＋ 新しい worktree を作る
        </button>
      </div>
    )
  }

  const add = async () => {
    if (!trimmed || refusal || adding) return
    setAdding(true)
    setError('')
    try {
      const res = await api.addWorktree(from, trimmed)
      onAdded(res.worktree)
      setOpen(false)
      setName('')
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setAdding(false)
    }
  }

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    // 外のフォーム（セッションを始める）を送らない。IME の変換中の Enter は確定なので作らない
    if (e.key === 'Enter') {
      e.preventDefault()
      if (!(e.nativeEvent.isComposing || e.keyCode === 229)) void add()
    }
  }

  return (
    <div className="new-worktree">
      <div className="row">
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={onKeyDown}
          disabled={adding || disabled}
          placeholder="新しい worktree の名前"
          aria-label="新しい worktree の名前"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          autoFocus
        />
        <button type="button" className="primary" disabled={adding || disabled || !trimmed || Boolean(refusal)} onClick={() => void add()}>
          {adding ? '作っています…' : '作る'}
        </button>
        <button type="button" disabled={adding} onClick={() => setOpen(false)}>
          やめる
        </button>
      </div>
      <div className="note">{project ? `${project} の ` : ''}worktree の隣に作り、同じ名前のブランチを手元の最新の base から切ります（fetch はしません）。消すのは端末で</div>
      {refusal && <div className="notice error">{refusal}</div>}
      {error && <div className="notice error">{error}</div>}
    </div>
  )
}
