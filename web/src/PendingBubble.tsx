import { elapsedLabel, hm, LONG_REPLY_MS, parseTs } from './format'

/**
 * 処理中の返信の仮バブル。サーバの replying（か送った直後のローカル）から出し、フックで行が届いたら
 * useReply の pending から外れて消える（届いた行の user_text が本物になる）。フィードでは repo を渡して
 * チャンネル名を添える。since からの経過を出し、長引いていれば色を変える。now はポーリングの updatedAt
 */
export function PendingBubble({ text, since, now, repo }: { text: string; since: string; now: number; repo?: string }) {
  const started = parseTs(since)?.getTime() ?? now
  const long = now - started > LONG_REPLY_MS
  const elapsed = elapsedLabel(since, now)
  return (
    <div className={`group pending${long ? ' long' : ''}`}>
      <div className="avatar me">私</div>
      <div>
        <div className="gh">
          <span className="name">あなた</span>
          {repo && <span className="ch">#{repo}</span>}
          <span className="time" title={`${hm(since)} に送信`}>{elapsed ? `処理中 ${elapsed}` : '送信中…'}</span>
        </div>
        <div className="msg">
          <div className="body">{text}</div>
        </div>
      </div>
    </div>
  )
}
