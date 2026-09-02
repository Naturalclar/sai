import { useEffect, useRef, useState } from 'react'
import { api, type ReplyingMap } from './api'

/** 画面に出す「処理中の返信」。サーバが伝えてきたものと、送った直後のローカルのものを同じ形にする */
export interface Pending {
  id: string
  text: string
  /** 起動（送信）した時刻 */
  since: string
}

/** 送った直後の返信。サーバの replying に載るまでの繋ぎ */
interface Sent {
  id: string
  text: string
  /** 送信時にその返信先に何行あったか。「終わったのに記録が増えなかった」の判定に使う */
  rowsAtSend: number
  sentAt: number
  /** 202 が返った時刻。null ならまだ返っていない */
  acceptedAt: number | null
}

/** 202 の後、この時間はサーバの replying に無くても「まだ届いていない」とみなす（ポーリングとの競合） */
const GRACE_MS = 1000

export const ENDED_WITHOUT_ROW = '返信は終わったが記録が増えなかった（~/.agent-feed/reply.log を見る）'

/**
 * 返信の送信と「処理中」の判定。SessionView と FeedView で共用。
 *
 * 「処理中」の正はサーバの `replying`（子プロセスが exit するまで残る）。リロードしても別タブでも同じものが
 * 見える。ローカルの `sent` は送信してからサーバの replying に載るまでの繋ぎで、載ったら捨てる。
 *
 * 終わり方は2つあり、どちらも `updatedAt`（ポーリングが返るたびに変わる）で見る:
 * - 行が増えた: 普通の完了。仮バブルは届いた行の user_text に置き換わる
 * - 行が増えないまま replying から消えた: プロセスは exit したが記録が無い（`claude -p` が許可待ちで落ちた、
 *   フックが失敗した）。これは何も起きなかったように見えるので、失敗として出す
 *
 * `countRows(id)` は呼び出し側が「いま画面にあるその返信先の行数」を返す。
 */
export function useReply(countRows: (id: string) => number, replying: ReplyingMap, updatedAt: Date | null) {
  const [sent, setSent] = useState<Sent[]>([])
  const [failed, setFailed] = useState<{ id: string; message: string } | null>(null)
  // サーバが「処理中」と言った id と、最初にそう見えたときの行数。消えたときに行が増えていなければ失敗
  const seen = useRef(new Map<string, number>())

  useEffect(() => {
    if (!updatedAt) return
    const now = updatedAt.getTime()

    // サーバが処理中と言っていたものが消えた
    for (const [id, rowsAtSeen] of seen.current) {
      if (replying[id]) continue
      seen.current.delete(id)
      if (countRows(id) <= rowsAtSeen) setFailed({ id, message: ENDED_WITHOUT_ROW })
    }
    for (const id of Object.keys(replying)) {
      if (!seen.current.has(id)) seen.current.set(id, countRows(id))
    }

    // ローカルの繋ぎ。サーバが引き継いだら捨てる。202 から少し待っても載らなければ、もう終わっている
    const keep = sent.filter((s) => {
      if (replying[s.id]) return false
      if (s.acceptedAt === null || now < s.acceptedAt + GRACE_MS) return true
      if (countRows(s.id) <= s.rowsAtSend) setFailed({ id: s.id, message: ENDED_WITHOUT_ROW })
      return false
    })
    if (keep.length !== sent.length) setSent(keep)
    // updatedAt が変わった描画の値（replying / countRows / sent）だけ見ればよい
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [updatedAt])

  const pending: Pending[] = [
    ...Object.entries(replying).map(([id, r]) => ({ id, text: r.text, since: r.since })),
    ...sent.filter((s) => !replying[s.id]).map((s) => ({ id: s.id, text: s.text, since: new Date(s.sentAt).toISOString() })),
  ]

  const send = async (id: string, text: string) => {
    const entry: Sent = { id, text, rowsAtSend: countRows(id), sentAt: Date.now(), acceptedAt: null }
    setFailed(null)
    setSent((list) => [...list.filter((s) => s.id !== id), entry])
    try {
      await api.reply(id, text)
      setSent((list) => list.map((s) => (s === entry ? { ...s, acceptedAt: Date.now() } : s)))
    } catch (err) {
      // 409（前の返信を処理中）もここ。次のポーリングでサーバの replying が付いて入力欄は閉じる
      setSent((list) => list.filter((s) => s !== entry))
      setFailed({ id, message: err instanceof Error ? err.message : String(err) })
    }
  }

  return { pending, failed, send }
}
