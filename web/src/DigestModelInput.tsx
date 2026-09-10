import { useState } from 'react'
import type { KeyboardEvent } from 'react'

/**
 * 一言を作るモデル名の欄（#288）。Enter か欄を離れたときに保存し、空にすれば「口の既定」（claude は haiku）。
 * 形の検査はサーバ（`shared/digestSettings.ts` の `isDigestModel`）で、通らなければ PUT のエラーが出る
 */
export function DigestModelInput({ value, placeholder, busy, onChange }: { value: string; placeholder: string; busy: boolean; onChange: (next: string) => void }) {
  const [draft, setDraft] = useState(value)
  const [editing, setEditing] = useState(false)
  const shown = editing ? draft : value
  const commit = () => {
    setEditing(false)
    const next = draft.trim()
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
      className="digest-model"
      value={shown}
      disabled={busy}
      placeholder={placeholder}
      aria-label="一言を作るモデル"
      title="一言を作るモデル名。空なら口の既定（claude は haiku。openai 互換は既定が無いので必須）"
      spellCheck={false}
      autoCapitalize="off"
      autoCorrect="off"
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
