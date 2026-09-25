import { useRef } from 'react'
import type { KeyboardEvent } from 'react'
import { moveIndex } from '../../shared/palette.ts'
import { Highlight } from './Highlight'
import type { WorkspaceMatch } from './workspaceFilter'

interface Props {
  query: string
  onQuery: (query: string) => void
  /** 絞ったあとの候補（当たりの良い順。`filterWorkspaces()`） */
  matches: readonly WorkspaceMatch[]
  /** いま選んでいる worktree の `from`（無ければ null） */
  chosen: string | null
  onSelect: (from: string) => void
  /** 絞り込み欄で Enter を押した（最初の指示の欄へ移る） */
  onPick: () => void
  disabled: boolean
}

/**
 * 新しいセッションの worktree を、打った文字で絞って選ぶ（#489）。`<select>` は打って絞れないので置き換えた。
 * **選んでいるのはハイライトしている 1 つ**（決定のボタンは無い）で、↑↓ で動かし、Enter で最初の指示の欄へ移る。
 * サーバに送るのは今までどおり `from` だけ（パスは送らない。#314）
 */
export function WorkspacePicker({ query, onQuery, matches, chosen, onSelect, onPick, disabled }: Props) {
  const listRef = useRef<HTMLUListElement>(null)
  // 親は「絞った候補の中の選んだもの、無ければ先頭」を chosen にするので、見つからなければ先頭
  const at = Math.max(0, matches.findIndex((m) => m.workspace.from === chosen))

  const move = (direction: 'prev' | 'next') => {
    const to = moveIndex(at, matches.length, direction)
    const next = matches[to]
    if (!next) return
    onSelect(next.workspace.from)
    listRef.current?.querySelectorAll('li.pick')[to]?.scrollIntoView({ block: 'nearest' })
  }

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      move(e.key === 'ArrowDown' ? 'next' : 'prev')
      return
    }
    // IME の変換中の Enter で決めない（候補の確定）。フォームも送らない（最初の指示がまだ）
    if (e.key === 'Enter' && !(e.nativeEvent.isComposing || e.keyCode === 229)) {
      e.preventDefault()
      if (matches.length > 0) onPick()
      return
    }
    // 打った文字があれば Esc で消す（入力欄のキーは App の「Esc でフィードへ」には届かない。isTypingTarget）
    if (e.key === 'Escape' && query) {
      e.preventDefault()
      e.stopPropagation()
      onQuery('')
    }
  }

  const activeId = matches.length > 0 ? `workspace-${at}` : undefined
  return (
    <div className="workspace-picker">
      <input
        value={query}
        onChange={(e) => onQuery(e.target.value)}
        onKeyDown={onKeyDown}
        disabled={disabled}
        placeholder="worktree を絞り込む（飛び飛びの文字でも当たる。↑↓ で選んで Enter）"
        aria-label="worktree を絞り込む"
        role="combobox"
        aria-expanded="true"
        aria-controls="workspace-list"
        {...(activeId ? { 'aria-activedescendant': activeId } : {})}
      />
      <ul className="workspace-list" id="workspace-list" role="listbox" aria-label="worktree" ref={listRef}>
        {matches.length === 0 && query && <li className="none">当たる worktree がありません</li>}
        {matches.map((m, i) => (
          <li
            key={m.workspace.from}
            id={`workspace-${i}`}
            className={`pick${i === at ? ' active' : ''}`}
            role="option"
            aria-selected={i === at}
            title={m.workspace.cwd}
            // 押しても絞り込み欄のフォーカスを奪わない（続けて打てるように）
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => onSelect(m.workspace.from)}
          >
            <span className="label">
              <Highlight text={m.label} hits={m.labelHits} />
            </span>
            <span className="cwd">
              <Highlight text={m.workspace.cwd} hits={m.cwdHits} />
            </span>
          </li>
        ))}
      </ul>
    </div>
  )
}
