import { hm } from './format'

interface Props {
  /** なぜ終わったか（行の text。`セッション終了: 会話をリセット（/clear）`） */
  text: string
  ts: string
}

/**
 * セッションが終わった区切り（#385。`SessionEnd` の行）。日付の区切りと同じ形で、発言の塊には入れない
 * （エージェントが言ったことではないので、アバターも名前も出さない）。
 *
 * `/clear` の回は、**ここより前をエージェントが覚えていない**ことがこの線で分かる（会話は新しい ID で続く）
 */
export function SessionEndLine({ text, ts }: Props) {
  return (
    <div className="chat-end">
      <span>
        {text || 'セッション終了'} <time>{hm(ts)}</time>
      </span>
    </div>
  )
}
