// 返答のバブル（#588）の下に出す「その場で返信する口」（#700）の中身を決める。DOM に依存しないので replyAcross.test.ts で回す
import { replyBlockedReason } from '../../shared/reply.ts'
import type { AgentFollowupLine, SessionSummary } from '../../shared/types.ts'

/** バブルの下の 1 行（「→ セッション A に『マージして』と送った 12:34」） */
export interface FooterLine {
  key: string
  toName: string
  text: string
  sentAt: string
  /** 相手がまだ返していなくて、返信を処理中か預かっている */
  busy: boolean
}

export interface ReplyFooter {
  /** 相手の呼び名（開いた入力欄が誰に送るのかを書く） */
  toName: string
  lines: FooterLine[]
  /** 入力欄を開けるか（相手が一覧の窓の中にいて、アーカイブ済みでなく、`replyBlockedReason()` が空） */
  canReply: boolean
  /** 1 押しで送る案（相手の `next_ask`）。出さないときは空 */
  quickAsk: string
}

/** 送った直後の、サーバの応答にまだ載っていない 1 行（次のポーリングまでの繋ぎ） */
export interface JustSent {
  to: string
  anchor: string
  text: string
  /** 送った時刻（ms。出す時刻と鍵にだけ使う） */
  at: number
  /**
   * 送ったときに、そのバブルの下にもう出ていた行の数（サーバの行と、まだ届いていない繋ぎ）。サーバの行がこれより増えたら届いたとみなす。
   * **時計では比べない**（携帯とサーバの時計がずれていると、届いた行と繋ぎが二重に出る）
   */
  known: number
}

export function replyFooter(input: {
  /** 相手のエンティティ ID */
  target: string
  /** このバブル（塊）に入っている返答の行の `ts` */
  tss: readonly string[]
  /** 相手のセッション（詳細の `agent_reply_sessions` から。無ければ返信の口は出さない） */
  session: SessionSummary | undefined
  /** 相手の呼び名（バブルの見出しと同じ） */
  toName: string
  followups: readonly AgentFollowupLine[]
  justSent: readonly JustSent[]
  /** 相手が返信を処理中か、預かりが残っている */
  targetBusy: boolean
  /** このサーバのマシン名 */
  host: string
}): ReplyFooter {
  const { target, tss, session, toName, followups, justSent, targetBusy, host } = input
  const here = followups.filter((f) => f.to === target && tss.includes(f.anchor))
  // 「処理中」を添えるのは、まだ返っていない一番新しい 1 行だけ（前の行にも付けると、どれを待っているのか分からない）
  const lastOpen = [...here].reverse().find((f) => !f.reply_ts)
  const lines: FooterLine[] = here.map((f) => ({ key: f.id, toName: f.to_name, text: f.text, sentAt: f.sent_at, busy: targetBusy && f === lastOpen }))
  for (const j of justSent) {
    if (j.to !== target || !tss.includes(j.anchor)) continue
    if (here.length > j.known) continue
    lines.push({ key: `just:${j.at}`, toName, text: j.text, sentAt: new Date(j.at).toISOString(), busy: true })
  }
  const canReply = Boolean(session && !session.archived && !replyBlockedReason(session, host))
  // 案は相手の最後のターンに付いたものなので、**相手の最新の返答のバブルにだけ**出す（前の返答の下に出すと、今の話でない案を送らせる）。
  // 相手が処理中・預かりが残っているときも出さない（案はそのターンが終わる前のもの）
  const latest = Boolean(session?.last_turn_ts && tss.includes(session.last_turn_ts))
  const quickAsk = canReply && latest && !targetBusy ? (session?.next_ask ?? '').trim() : ''
  return { toName, lines, canReply, quickAsk }
}

/** 送った直後の繋ぎを足す。`known` はいまそのバブルの下に出ている行の数（サーバの行 + まだ届いていない繋ぎ） */
export function withJustSent(just: readonly JustSent[], followups: readonly AgentFollowupLine[], sent: Omit<JustSent, 'known'>, tss: readonly string[]): JustSent[] {
  const here = followups.filter((f) => f.to === sent.to && tss.includes(f.anchor)).length
  const waiting = just.filter((j) => j.to === sent.to && tss.includes(j.anchor) && j.known >= here).length
  return [...just.slice(-9), { ...sent, known: here + waiting }]
}
