import { useState } from 'react'

/**
 * 差分の行の下に開くコメント欄（#511）。⌘Enter / Ctrl+Enter で残し、Esc でやめる。
 * **Esc は外へ流さない**（狭い画面の差分はモーダルで、流すとモーダルごと閉じて書きかけが消える）
 */
export function DiffCommentEditor({ onSave, onCancel }: { onSave: (body: string) => void; onCancel: () => void }) {
  const [body, setBody] = useState('')
  const save = () => {
    if (body.trim()) onSave(body)
  }
  return (
    <div className="diff-comment-editor">
      <textarea
        autoFocus
        value={body}
        placeholder="この行へのコメント（⌘Enter で残す・Esc でやめる）"
        aria-label="この行へのコメント"
        onChange={(e) => setBody(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.stopPropagation()
            onCancel()
          } else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
            e.preventDefault()
            save()
          }
        }}
      />
      <div className="actions">
        <button type="button" onClick={onCancel}>やめる</button>
        <button type="button" className="primary" disabled={!body.trim()} onClick={save}>残す</button>
      </div>
    </div>
  )
}
