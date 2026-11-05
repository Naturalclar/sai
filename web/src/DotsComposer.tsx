import { useState } from 'react'
import type { DotsConversation } from '../../shared/dots.ts'
import { DOTS_TEXT_MAX } from '../../shared/dots.ts'
import { dotsTitle } from './dotsLog.ts'

interface Props {
  /** 送り先。null は新しい会話、文字列は送った直後でまだ一覧に無い会話 */
  target: DotsConversation | string | null
  onNew: () => void
  onSend: (text: string) => Promise<void>
}

/** dots への入力欄（#872）。⌘Enter / Ctrl+Enter でも送る。送れなかったら本文は残す */
export function DotsComposer({ target, onNew, onSend }: Props) {
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const over = [...text].length > DOTS_TEXT_MAX
  const can = text.trim() !== '' && !busy && !over

  const submit = async () => {
    if (!can) return
    setBusy(true)
    setError('')
    try {
      await onSend(text)
      setText('')
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const label = target === null ? '新しい会話を始めます' : typeof target === 'string' ? '続けて送ります' : `「${dotsTitle(target)}」に続けて送ります`
  return (
    <div className="dots-composer">
      <div className="dots-target">
        <span>{label}</span>
        {target !== null && (
          <button type="button" onClick={onNew}>
            新しい会話にする
          </button>
        )}
      </div>
      <div className="dots-input">
        <textarea
          value={text}
          rows={3}
          placeholder="dots に頼むこと"
          aria-label="dots に送る本文"
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && !e.nativeEvent.isComposing) {
              e.preventDefault()
              void submit()
            }
          }}
        />
        <button type="button" className="primary" disabled={!can} onClick={() => void submit()}>
          {busy ? '送っています…' : '送る'}
        </button>
      </div>
      {over && <div className="dots-error">{DOTS_TEXT_MAX} 文字までです</div>}
      {error && <div className="dots-error">送れませんでした: {error}</div>}
    </div>
  )
}
