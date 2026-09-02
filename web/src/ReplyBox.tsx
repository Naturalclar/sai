import { useState } from 'react'
import type { KeyboardEvent } from 'react'

/** 画面2の入力欄。Enter で送信、Shift+Enter で改行。IME 変換中の Enter は送らない */
export function ReplyBox({ repo, busy, onSend }: { repo: string; busy: boolean; onSend: (text: string) => void }) {
  const [text, setText] = useState('')

  const submit = () => {
    const t = text.trim()
    if (!t || busy) return
    onSend(t)
    setText('')
  }

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key !== 'Enter' || e.shiftKey) return
    // 日本語入力の確定 Enter で送らない（isComposing が立つ。古い実装は keyCode 229）
    if (e.nativeEvent.isComposing || e.keyCode === 229) return
    e.preventDefault()
    submit()
  }

  return (
    <form
      className="reply"
      onSubmit={(e) => {
        e.preventDefault()
        submit()
      }}
    >
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={onKeyDown}
        placeholder={`#${repo} に返信（Enter で送信、Shift+Enter で改行）`}
        rows={2}
        disabled={busy}
      />
      <button type="submit" disabled={busy || !text.trim()}>
        {busy ? '送信中…' : '送信'}
      </button>
    </form>
  )
}
