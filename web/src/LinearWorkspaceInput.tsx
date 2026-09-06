import { useState } from 'react'
import type { KeyboardEvent } from 'react'

/**
 * ヘッダの「Linear の workspace」。一言の中の PGR-123 のような識別子を linear.app/<workspace>/issue/… に向けるための設定。
 * 値はサーバ（PUT /api/settings）。Enter か欄を離れたときに保存し、空にすれば「設定なし」（リンクにしない）
 */
export function LinearWorkspaceInput({ value, busy, onChange }: { value: string; busy: boolean; onChange: (next: string) => void }) {
  const [draft, setDraft] = useState(value)
  const [editing, setEditing] = useState(false)
  const shown = editing ? draft : value
  const commit = () => {
    setEditing(false)
    const next = draft.trim().toLowerCase()
    if (next !== value) onChange(next)
  }
  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
      e.preventDefault()
      e.currentTarget.blur()
    }
    if (e.key === 'Escape') {
      setDraft(value)
      setEditing(false)
      e.currentTarget.blur()
    }
  }
  return (
    <input
      className="linear-ws"
      value={shown}
      disabled={busy}
      placeholder="Linear の workspace"
      aria-label="Linear の workspace（linear.app/<workspace>/ の部分）"
      title="一言の中の PGR-123 のような識別子を linear.app/<workspace>/issue/… に向ける。空ならリンクにしない"
      spellCheck={false}
      onFocus={() => {
        setDraft(value)
        setEditing(true)
      }}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={onKeyDown}
    />
  )
}
