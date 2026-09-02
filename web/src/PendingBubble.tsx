import { elapsedLabel, hm, LONG_REPLY_MS, parseTs } from './format'

/**
 * 処理中の返信の仮バブル。サーバの replying（か送った直後のローカル）から出し、フックで行が届いたら
 * useReply の pending から外れて消える（届いた行の user_text が本物になる）。quiet なら本文を出さない
 * （入力の行が先に届いて本物の自分バブルがもう出ている）。フィードでは repo を渡して
 * チャンネル名を添える。since からの経過を出し、長引いていれば色を変える。now はポーリングの updatedAt
 */
export function PendingBubble({ text, since, now, repo, quiet }: { text: string; since: string; now: number; repo?: string; quiet?: boolean }) {
  const started = parseTs(since)?.getTime() ?? now
  const long = now - started > LONG_REPLY_MS
  const elapsed = elapsedLabel(since, now)
  if (quiet) {
    // 入力の行（UserPromptSubmit）が届いて本物の自分バブルが出ている。本文は重ねず「処理中」の1行だけ
    return (
      <div className={`pending-line${long ? ' long' : ''}`} title={`${hm(since)} に送信`}>
        <span>⏳</span>
        {repo && <span className="ch">#{repo}</span>}
        <span className="time">{elapsed ? `処理中 ${elapsed}` : '処理中…'}</span>
      </div>
    )
  }
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
