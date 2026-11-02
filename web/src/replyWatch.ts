// サーバの `replying` をポーリングのたびに見て、返信の失敗を見つける（`useReply` の判定。DOM に依らないので replyWatch.test.ts で回す）。
import { splitAttachments } from '../../shared/attachments.ts'
import type { Replying, ReplyingMap } from './api'

export const ENDED_WITHOUT_ROW = '返信は終わったが記録が増えなかった（~/.agent-feed/reply.log を見る）'

/** Claude のログインが切れているときの文（#685。バナーと返信の失敗で同じ文を出す） */
export const CLAUDE_LOGGED_OUT = 'Claude のログインが切れています。画面の上の「SAI からログインする」か、Mac の端末で claude auth login を打ってから送り直してください'

/**
 * サーバが「返信が失敗した」と言っているときの文（#172）。プロセスが非0で終わったときは理由が reply.log の末尾から来る。
 * 端末・開いている Codex の queue に渡して届かなかったとき（#329）は終了コードが無く、理由だけ
 */
export function replyFailureMessage(failed: NonNullable<Replying['failed']>): string {
  const why = failed.tail.trim()
  // Claude のログインが切れている（#685）。CLI の文言より先に、直し方を出す
  if (failed.logged_out) return `${CLAUDE_LOGGED_OUT}（終了コード ${failed.code}）${why ? `: ${why}` : ''}`
  // 届いたが、ターンがエラーで終わった（#475）。「届いていません」と出すと、届いた指示を送り直させてしまう
  if (failed.turn_error) return `返信は届きましたが、${why || 'ターンがエラーで終わりました'}`
  if (failed.code === undefined) return `返信が届いていません${why ? `: ${why}` : ''}`
  return `返信が失敗しました（終了コード ${failed.code}）${why ? `: ${why}` : '。~/.agent-feed/reply.log を見てください'}`
}

/** 送った本文から、添えた画像のパスの塊を外す（打ったままの本文に戻す。#350） */
export const typedText = (text: string): string => splitAttachments(text).body

/**
 * 送れなかった返信（#172 / #350）。`text` は打った本文で、画面が「入力欄に戻す」に使う。
 * 添えた画像のパスは本文の末尾に足されているので `splitAttachments()` で外す（画像そのものは戻せない）
 */
export interface ReplyFailed {
  id: string
  message: string
  /** 打った本文。分からなければ空（そのときは戻すボタンを出さない） */
  text: string
}

/** ポーリングをまたいで覚えておくこと */
export interface ReplyWatch {
  /** サーバが「処理中」と言った id と、最初にそう見えたときの行数・本文。消えたときに行が増えていなければ失敗（本文は「入力欄に戻す」に使う。#350） */
  seen: Map<string, { rows: number; text: string }>
  /** 失敗を出した id。サーバは少しの間その分を返し続けるので、毎回のポーリングで出し直さない */
  reported: Set<string>
}

export const newReplyWatch = (): ReplyWatch => ({ seen: new Map(), reported: new Set() })

/** 1 回のポーリングぶんを見て、いま出す失敗を返す（古い順。`watch` は更新する） */
export function watchReplies(watch: ReplyWatch, replying: ReplyingMap, countRows: (id: string) => number): ReplyFailed[] {
  const { seen, reported } = watch
  const failures: ReplyFailed[] = []

  // サーバが「プロセスが非0で終わった」と言っている。処理中ではなく理由を出す
  for (const [id, r] of Object.entries(replying)) {
    if (!r.failed || reported.has(id)) continue
    reported.add(id)
    seen.delete(id)
    // 要約だけのターンの `text` は打った本文でなく `/compact` の指示で、本文は預かりに残っている。戻すものが無い（#851）
    failures.push({ id, message: replyFailureMessage(r.failed), text: r.compact ? '' : typedText(r.text) })
  }
  for (const id of reported) if (!replying[id]?.failed) reported.delete(id)

  // サーバが処理中と言っていたものが消えた
  for (const [id, at] of seen) {
    if (replying[id]) continue
    seen.delete(id)
    if (countRows(id) <= at.rows) failures.push({ id, message: ENDED_WITHOUT_ROW, text: at.text })
  }
  for (const [id, r] of Object.entries(replying)) {
    // 失敗はもう上で出した。入れ直すと、失敗の分が消えたとき（期限切れ・次の要約の終わり）に「記録が増えなかった」と重ねて出る（#850）。
    // 要約だけのターンは行を増やさず本文は預かりにあるので、「記録が増えなかった」とは見ない（#837）
    if (!seen.has(id) && !r.failed && !r.compact) seen.set(id, { rows: countRows(id), text: typedText(r.text) })
  }
  return failures
}
