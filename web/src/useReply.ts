import { useEffect, useRef, useState } from 'react'
import { api, ApiError, type Replying, type ReplyingMap } from './api'

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

/** サーバが「プロセスが非0で終わった」と言っているときの文（#172）。理由は reply.log の末尾から来る */
export function replyFailureMessage(failed: NonNullable<Replying['failed']>): string {
  const why = failed.tail.trim()
  return `返信が失敗しました（終了コード ${failed.code}）${why ? `: ${why}` : '。~/.agent-feed/reply.log を見てください'}`
}

/**
 * 端末に打ち込めなくて送れなかった。人にどうするかを聞く（#117、#157）。
 * typed: 打ちかけがある（「消して送る」か「端末を使わず送る」）。process: 消せなかった・ダイアログ中・入力欄が読めない（後者だけ）
 */
export interface ReplaceConfirm {
  id: string
  kind: 'typed' | 'process'
  /** 送ろうとした本文 */
  text: string
  /** 端末の入力欄に見えている文（typed のとき） */
  typed: string
  /** 端末に打てない理由（process のとき。サーバの文） */
  reason: string
  /** 端末を使わない経路がある（Claude は resume、active Codex は queue） */
  canProcess: boolean
}

/** send の結果。confirm のとき呼び出し側は本文を入力欄に戻す */
export type SendOutcome = 'sent' | 'confirm' | 'failed'

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
  const [confirm, setConfirm] = useState<ReplaceConfirm | null>(null)
  // サーバが「処理中」と言った id と、最初にそう見えたときの行数。消えたときに行が増えていなければ失敗
  const seen = useRef(new Map<string, number>())
  // 失敗を出した id。サーバは少しの間その分を返し続けるので、毎回のポーリングで出し直さない
  const reportedFailure = useRef(new Set<string>())

  useEffect(() => {
    if (!updatedAt) return
    const now = updatedAt.getTime()

    // サーバが「プロセスが非0で終わった」と言っている。処理中ではなく理由を出す
    for (const [id, r] of Object.entries(replying)) {
      if (!r.failed || reportedFailure.current.has(id)) continue
      reportedFailure.current.add(id)
      seen.current.delete(id) // 消えたときに「記録が増えなかった」を重ねて出さない
      setFailed({ id, message: replyFailureMessage(r.failed) })
    }
    for (const id of reportedFailure.current) if (!replying[id]?.failed) reportedFailure.current.delete(id)

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
    // 失敗した分は「処理中」ではない（入力欄を開けて、理由は failed に出す）
    ...Object.entries(replying)
      .filter(([, r]) => !r.failed)
      .map(([id, r]) => ({ id, text: r.text, since: r.since })),
    ...sent.filter((s) => !replying[s.id]).map((s) => ({ id: s.id, text: s.text, since: new Date(s.sentAt).toISOString() })),
  ]

  const send = async (id: string, text: string, options: { replaceTyped?: boolean; via?: 'process'; attachments?: string[] } = {}): Promise<SendOutcome> => {
    const entry: Sent = { id, text, rowsAtSend: countRows(id), sentAt: Date.now(), acceptedAt: null }
    setFailed(null)
    setConfirm(null)
    setSent((list) => [...list.filter((s) => s.id !== id), entry])
    try {
      await api.reply(id, text, options)
      setSent((list) => list.map((s) => (s === entry ? { ...s, acceptedAt: Date.now() } : s)))
      return 'sent'
    } catch (err) {
      // 409（前の返信を処理中）もここ。次のポーリングでサーバの replying が付いて入力欄は閉じる
      setSent((list) => list.filter((s) => s !== entry))
      // 端末に打ち込めなかった（打ちかけ・ダイアログ中・入力欄が読めない）。失敗ではなく、どうするかを聞く。
      // 打ちかけがあるだけなら「消して送る」も出す。「消して送る」で送り直してなお残っている（消せない端末）、
      // ダイアログ中、入力欄不明なら「端末を使わず送る」だけ（#157。SAI から何も送れない、にしない）
      if (err instanceof ApiError) {
        // 打ちかけを消すか、端末を使わない経路（Claude の resume / Codex の queue）を選べる。
        if (err.code === 'terminal_typed' && !options.replaceTyped) {
          setConfirm({ id, kind: 'typed', text, typed: err.typed ?? '', reason: err.message, canProcess: err.canProcess })
          return 'confirm'
        }
        if (err.canProcess) {
          const reason =
            err.code === 'terminal_typed'
              ? `端末の打ちかけを消せなかった（まだ残っている: ${(err.typed ?? '').split('\n')[0]}）`
              : err.message
          setConfirm({ id, kind: 'process', text, typed: err.typed ?? '', reason, canProcess: true })
          return 'confirm'
        }
      }
      setFailed({ id, message: err instanceof Error ? err.message : String(err) })
      return 'failed'
    }
  }

  /** 確認に「消して送る」と答えた。打ちかけを消して同じ本文を送り直す */
  const confirmReplace = async (): Promise<SendOutcome> => {
    if (!confirm) return 'failed'
    const { id, text } = confirm
    return send(id, text, { replaceTyped: true })
  }
  /** 確認に「端末を使わず送る」と答えた。サーバが resume / queue を選んで同じ本文を送る */
  const confirmProcess = async (): Promise<SendOutcome> => {
    if (!confirm) return 'failed'
    const { id, text } = confirm
    return send(id, text, { via: 'process' })
  }
  const cancelConfirm = () => setConfirm(null)

  return { pending, failed, send, confirm, confirmReplace, confirmProcess, cancelConfirm }
}
