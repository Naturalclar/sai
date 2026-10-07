// セッションから別のセッションへのメッセージのようす（#311）の、画面の文言。DOM に依らないので node:test で回す（agentActivity.test.ts）
import { tokensLabel } from '../../shared/agentMessages.ts'
import type { AgentActivity, AgentActivityMessage, AgentHeldMessage } from '../../shared/types.ts'

/** 枠の見出しの 1 行。`このターン 2/3 回 · 読み直させた量 約 180 万トークン / 約 300 万トークン`（読み直させた量が分からなければ付けない） */
export function activitySummary(a: AgentActivity): string {
  const parts = [`このターン ${a.sent}/${a.limit} 回`]
  if (a.read_tokens > 0) parts.push(`読み直させた量 ${tokensLabel(a.read_tokens)} / ${tokensLabel(a.read_budget)}`)
  // 1 ターンの回数を超えて預かっている分（#727）。ターンが終わってから順に送る
  if (a.held && a.held.length > 0) parts.push(`預かり ${a.held.length} 件`)
  return parts.join(' · ')
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
