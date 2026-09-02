/**
 * 送信した返信の仮バブル。フックで行が届いたら useReply の pending から外れて消える
 * （届いた行の user_text が本物になる）。フィードでは repo を渡してチャンネル名を添える
 */
export function PendingBubble({ text, repo }: { text: string; repo?: string }) {
  return (
    <div className="group pending">
      <div className="avatar me">私</div>
      <div>
        <div className="gh">
          <span className="name">あなた</span>
          {repo && <span className="ch">#{repo}</span>}
          <span className="time">送信中…</span>
        </div>
        <div className="msg">
          <div className="body">{text}</div>
        </div>
      </div>
    </div>
  )
}
