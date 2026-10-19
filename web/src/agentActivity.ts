// セッションから別のセッションへのメッセージのようす（#311）の、画面の文言。DOM に依らないので node:test で回す（agentActivity.test.ts）
import { tokensLabel } from '../../shared/agentMessages.ts'
import { readNear, sentNear } from '../../shared/agentWaiting.ts'
import { WHY_LABEL } from '../../shared/holding.ts'
import type { AgentActivity, AgentActivityMessage, AgentHeldMessage } from '../../shared/types.ts'

/**
 * 枠の見出しの 1 行（#823）。往復数と読み直させた量は**上限に近いときだけ**（線は `shared/agentWaiting.ts`）。
 * `このターン 2/3 回 · 読み直させた量 約 180 万トークン / 約 300 万トークン · 預かり 1 件`。どれも無ければ空
 */
export function activitySummary(a: AgentActivity): string {
  const parts: string[] = []
  if (sentNear(a)) parts.push(`このターン ${a.sent}/${a.limit} 回`)
  if (readNear(a)) parts.push(`読み直させた量 ${tokensLabel(a.read_tokens)} / ${tokensLabel(a.read_budget)}`)
  // 1 ターンの回数を超えて預かっている分（#727）。ターンが終わってから順に送る
  if (a.held && a.held.length > 0) parts.push(`預かり ${a.held.length} 件`)
  return parts.join(' · ')
}

/** 返答待ちの相手の状態の語（#823）。語は `sai_sessions` の「空きでない理由」（`WHY_LABEL`）と同じ。分からなければ空 */
export function targetWhyLabel(m: Pick<AgentActivityMessage, 'status' | 'to_why' | 'far'>): string {
  if (m.status !== 'pending' || m.far || !m.to_why) return ''
  return WHY_LABEL[m.to_why]
}

/** 送った 1 件の状態 */
export function messageStatusLabel(status: AgentActivityMessage['status']): string {
  if (status === 'done') return '返答あり'
  if (status === 'failed') return '失敗'
  return '返答待ち'
}

/** 預かっている 1 件の状態（#727）。`n` は並びの中の位置（0 始まり）。止まっているものは理由を title に出す */
export function heldStatusLabel(h: Pick<AgentHeldMessage, 'halted'>, n: number): string {
  return h.halted ? '送っていません（止まっています）' : `預かり（${n + 1} 番目に送ります）`
}
