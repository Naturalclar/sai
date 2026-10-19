// 別のセッションへのメッセージの「まだ終わっていないもの」（#823）。枠を出すか・枠に並べる行・往復数を出すか・一覧と見出しの
// 「返答待ち N」を、ここ 1 か所で決める（枠・サイドバー・見出しが同じ関数を使う）。DOM にもファイルにも触らない（shared/agentWaiting.test.ts）
import { deliveredId, deliveryMatcher } from './agentMessages.ts'
import { entityId } from './entity.ts'
import type { AgentActivity, AgentActivityMessage, AgentHeldMessage, AgentWaitCount, FeedRow, HoldingWhy } from './types.ts'

/** 往復数を枠に出す線（このターンで送った回数が上限のこの割合以上） */
export const AGENT_SENT_NEAR = 2 / 3
/** 読み直させた量を枠に出す線（このターンで読み直させた量が上限のこの割合以上） */
export const AGENT_READ_NEAR = 1 / 2

/** 相手の状態として返答待ちの行に添える理由（#823）。処理中・端末で作業中・待ち・預かりありだけ（作りかけ・PR などは返答と関係が無い） */
export const AGENT_TARGET_WHYS: readonly HoldingWhy[] = ['busy', 'terminal', 'waiting', 'queued']

/**
 * まだ終わっていない数。返答待ち＋預かり（止まっていないもの）を `waiting`、失敗と、預かりのまま止まったものを `failed` に数える。
 * 返答ありは数えない
 */
export function agentWaitCount(a: { recent: readonly Pick<AgentActivityMessage, 'status'>[]; held?: readonly Pick<AgentHeldMessage, 'halted'>[] | undefined }): AgentWaitCount {
  let waiting = 0
  let failed = 0
  for (const m of a.recent) {
    if (m.status === 'pending') waiting++
    else if (m.status === 'failed') failed++
  }
  for (const h of a.held ?? []) {
    if (h.halted) failed++
    else waiting++
  }
  return { waiting, failed }
}

/** 一覧と見出しに印を出すか。返答待ちも失敗も無ければ出さない */
export function agentWaitShown(c: AgentWaitCount | null | undefined): c is AgentWaitCount {
  return Boolean(c && (c.waiting > 0 || c.failed > 0))
}

/** 印の文字。返答待ちがあればその数、無くて失敗だけなら失敗の数 */
export function agentWaitLabel(c: AgentWaitCount): string {
  return c.waiting > 0 ? `返答待ち ${c.waiting}` : `送信の失敗 ${c.failed}`
}

/** 枠を出すか。返答待ち・預かり・失敗のどれかがあるか、送信を止めているときだけ */
export function agentActivityShown(a: AgentActivity | null | undefined): boolean {
  return Boolean(a && (a.stopped || agentWaitShown(agentWaitCount(a))))
}

/** 枠に並べる送った行。返答ありは出さない */
export function openMessages(recent: readonly AgentActivityMessage[]): AgentActivityMessage[] {
  return recent.filter((m) => m.status !== 'done')
}

/** 往復数を出すか（上限に近いときだけ） */
export function sentNear(a: Pick<AgentActivity, 'sent' | 'limit'>): boolean {
  return a.limit > 0 && a.sent >= a.limit * AGENT_SENT_NEAR
}

/** 読み直させた量を出すか（上限に近いときだけ。分からない（0）なら出さない） */
export function readNear(a: Pick<AgentActivity, 'read_tokens' | 'read_budget'>): boolean {
  return a.read_tokens > 0 && a.read_budget > 0 && a.read_tokens >= a.read_budget * AGENT_READ_NEAR
}

/** 返答の行を探すとき、一番古い送った時刻よりこれだけ前の行から舐める（行の時刻は秒まで・時計のずれ） */
export const ANSWER_SLACK_MS = 5 * 60_000

/**
 * 送ったメッセージのうち、返答（そのメッセージで回った相手のターン完了の行）があるものの id（#823）。
 * 行は 1 回だけ舐め、**一番古い送った時刻より前の行は見ない**（3 秒のポーリングで 90 日ぶんを舐めない）。`rows` は古い順
 */
export function answeredIds(open: readonly { message_id: string; to: string; since: string }[], rows: readonly FeedRow[]): Set<string> {
  const out = new Set<string>()
  if (open.length === 0) return out
  const want = new Map(open.map((m) => [m.message_id, m.to]))
  // 送った時刻が読めないものがあれば、全部を舐める（返答を取りこぼさない）
  const from = Math.min(...open.map((m) => Date.parse(m.since)).map((ms) => (Number.isFinite(ms) ? ms : -Infinity)))
  let start = rows.length
  // 入力の行は送ったあとに書かれるので、送った時刻より前に戻らなくてよい。行の時刻は秒までで、時計のずれもあるので少し余分に戻る
  while (start > 0 && !(Date.parse(rows[start - 1]?.ts ?? '') < from - ANSWER_SLACK_MS)) start--
  const matcher = deliveryMatcher()
  for (let i = start; i < rows.length; i++) {
    const r = rows[i] as FeedRow
    const id = deliveredId(matcher.headOf(r))
    if (id && want.get(id) === entityId(r.session ?? '', r.repo ?? '', String(r.ts ?? ''))) out.add(id)
  }
  return out
}
