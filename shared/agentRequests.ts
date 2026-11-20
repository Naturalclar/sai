// 依頼ごとの進み具合（#902）。送り元の 1 ターン（`AgentMessage.turn` = そのターンの `Replying.since`）に振った先を、
// 送った記録・預かり・状態（`agentStatuses()`）・返答の行（`agentReplyRows()`）から束ねる。**新しい台帳は持たない**
// （毎回ここで組み立てる）。行は舐めない（状態も返答の行も呼び出し側が 1 回で引いたものを渡す）ので、3 秒のポーリングを重くしない
import type { AgentActivityMessage, AgentRequest, AgentRequestItem } from './types.ts'

/**
 * 依頼を載せる線（#902。これより前に始まったターンは載せない）。描いていない行（`recentRows()` が落とした行）の一番新しい時刻。
 * それより後に始まったターンの行は全部描いているので、置き場所のバブルが必ず窓の中にある。落とした行が無ければ（読める時刻が無ければ）`floor`（読んだ日数の頭）
 */
export function requestsWindowStart(dropped: readonly { ts?: string }[], floor: number): number {
  const times = dropped.map((r) => Date.parse(r.ts ?? '')).filter((ms) => Number.isFinite(ms))
  return times.length > 0 ? Math.max(...times) : floor
}

/** 束ねるのに要る送った記録の形（`server/reply/agentMessages.ts` の `AgentMessage` の一部） */
export interface RequestSent {
  message_id: string
  to: string
  since: string
  turn?: string
  far?: true
}

/** 束ねるのに要る預かりの形（`HeldSend` の一部） */
export interface RequestHeld {
  message_id: string
  to: string
  turn: string
  at: string
  halted?: string
  far?: true
}

/**
 * ターンごとに束ねる（ターンの古い順、中は送った順）。`turn` の無い記録（それより前の形）は束ねない（どの依頼か分からない）。
 * `notBefore` より前に始まったターンは載せない（描いている窓の外。画面に置く場所が無い）。
 * 状態が分からないもの（`statusOf` が undefined）は返答待ちにする（`agentActivityOf()` の直近の行と同じ）。
 * 返答の行の `ts` は `replyTs` に**あるときだけ**付ける（返答ありでも行が見つからなければ付けない。画面はそのとき飛び先を出さない）
 */
export function agentRequests(
  sent: readonly RequestSent[],
  held: readonly RequestHeld[],
  statusOf: (messageId: string) => AgentActivityMessage['status'] | undefined,
  nameOf: (to: string) => string,
  replyTs: ReadonlyMap<string, string> = new Map(),
  notBefore = -Infinity,
): AgentRequest[] {
  const groups = new Map<string, AgentRequestItem[]>()
  const push = (turn: string, item: AgentRequestItem) => {
    const ms = Date.parse(turn)
    if (Number.isFinite(ms) && ms < notBefore) return
    const list = groups.get(turn)
    if (list) list.push(item)
    else groups.set(turn, [item])
  }
  for (const m of sent) {
    if (!m.turn) continue
    const status = statusOf(m.message_id) ?? 'pending'
    const ts = replyTs.get(m.message_id)
    push(m.turn, { message_id: m.message_id, to: m.to, to_name: nameOf(m.to), status, at: m.since, ...(ts ? { reply_ts: ts } : {}), ...(m.far ? { far: true as const } : {}) })
  }
  for (const h of held) {
    // 預かりのまま止まったものは送っていない。返答は来ないので失敗に数える（理由は `halted`）
    push(h.turn, { message_id: h.message_id, to: h.to, to_name: nameOf(h.to), status: h.halted ? 'failed' : 'held', at: h.at, ...(h.halted ? { halted: h.halted } : {}), ...(h.far ? { far: true as const } : {}) })
  }
  const at = (s: string) => {
    const ms = Date.parse(s)
    return Number.isFinite(ms) ? ms : 0
  }
  return [...groups.entries()]
    .map(([turn, items]) => ({ turn, items: items.map((item, i) => ({ item, i })).sort((a, b) => at(a.item.at) - at(b.item.at) || a.i - b.i).map(({ item }) => item) }))
    .sort((a, b) => at(a.turn) - at(b.turn))
}

/** 詳細の rev に混ぜる鍵（#902）。状態と返答の行が変わったときだけ変わる */
export function agentRequestsKey(requests: readonly AgentRequest[] | undefined): string {
  return (requests ?? []).map((r) => `${r.turn}:${r.items.map((i) => `${i.message_id}=${i.status}${i.reply_ts ? `@${i.reply_ts}` : ''}`).join('+')}`).join(',')
}
