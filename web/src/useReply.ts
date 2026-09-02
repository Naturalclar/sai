import { useState } from 'react'
import { api } from './api'

/** 送信した返信。どのエンティティに、そのとき何行あったか */
export interface Sent {
  id: string
  text: string
  rowsAtSend: number
}

/**
 * 返信の送信と「送信中」の判定。SessionView と FeedView で共用。
 * 「送信中」は state を消すのではなく描画時に決める。返信の結果は既存のフックが JSONL に足す1行として
 * 届くので、その返信先の行数が送信時より増えたら消える。rev や画面全体の行数ではなく返信先の行数で
 * 見るのは、同じ日のファイルに別セッションの行が増えても rev は変わり、フィードでは全体の行数も増えるため。
 * `countRows(id)` は呼び出し側が「いま画面にあるその返信先の行数」を返す。
 */
export function useReply(countRows: (id: string) => number) {
  const [sent, setSent] = useState<Sent[]>([])
  const [failed, setFailed] = useState<{ id: string; message: string } | null>(null)

  const pending = sent.filter((s) => countRows(s.id) <= s.rowsAtSend)

  const send = async (id: string, text: string) => {
    const entry: Sent = { id, text, rowsAtSend: countRows(id) }
    setFailed(null)
    setSent((list) => [...list.filter((s) => s.id !== id), entry])
    try {
      await api.reply(id, text)
    } catch (err) {
      setSent((list) => list.filter((s) => s !== entry))
      setFailed({ id, message: err instanceof Error ? err.message : String(err) })
    }
  }

  return { pending, failed, send }
}
