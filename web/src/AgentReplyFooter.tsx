import type { ReactNode } from 'react'
import { hm } from './format'
import type { ReplyFooter } from './replyAcross'

interface Props {
  footer: ReplyFooter
  /** 入力欄を開いているか */
  open: boolean
  onToggle: () => void
  /** 案を 1 押しで送る */
  onQuick: (text: string) => void
  /** 送っている最中（二重に押させない） */
  sending: boolean
  /** 開いているときの入力欄と、送信失敗の案内 */
  children?: ReactNode
}

/**
 * 返答のバブル（#588）の下の「その場で相手へ返信する口」（#700）。人が相手のセッションへ直接送る（送り元のターンは起こさない）。
 * 送ったことはバブルにせず小さい 1 行で出し、相手のそのあとの返答は同じ並びに別のバブルとして出る。
 * 狭い画面でもリンクに落とさず、ここで開く
 */
export function AgentReplyFooter({ footer, open, onToggle, onQuick, sending, children }: Props) {
  if (footer.lines.length === 0 && !footer.canReply) return null
  return (
    <div className="reply-footer">
      {footer.lines.map((l) => (
        <div className="followup-line" key={l.key}>
          <span className="followup-text">→ {l.toName} に「{l.text}」と送った</span>
          <span className="time">{hm(l.sentAt)}</span>
          {l.busy && <span className="tag busy">処理中</span>}
        </div>
      ))}
      {footer.canReply && (
        <div className="reply-footer-acts">
          <button type="button" className="reply-here" aria-expanded={open} onClick={onToggle}>
            {open ? '閉じる' : '返信'}
          </button>
          {/* 下の入力欄は、いま開いているセッションではなく相手に送る */}
          {open && <span className="reply-footer-to">{footer.toName} のセッションへ送ります</span>}
          {footer.quickAsk && !open && (
            <button type="button" className="reply-here quick" disabled={sending} title="相手の「次に送る文面の案」をそのまま送る" onClick={() => onQuick(footer.quickAsk)}>
              「{footer.quickAsk}」と送る
            </button>
          )}
        </div>
      )}
      {children}
    </div>
  )
}
