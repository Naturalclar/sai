import { useState } from 'react'

/**
 * 狭い画面のチャット見出しの 2 行目（#274）。題名（一番新しい `user_text`）を 1 行で省略し、押すと全文に開く。
 * 題名は `TITLE_FULL_LEN`（300 文字）まで入り、折り返しに上限を付けないと見出しが何行にも伸びる。
 * 呼び出し側は key にセッション ID を混ぜること（別のセッションに移ったら閉じた状態に戻す）
 */
export function SessionTitle({ text }: { text: string }) {
  const [open, setOpen] = useState(false)
  return (
    <button type="button" className={`head-title${open ? ' open' : ''}`} onClick={() => setOpen((v) => !v)} aria-expanded={open} title={open ? '題名をたたむ' : text}>
      {text}
    </button>
  )
}
