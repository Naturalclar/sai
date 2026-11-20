// 依頼ごとの進み具合（#902）の、画面の文言と置き場所。DOM に依らないので node:test で回す（agentRequests.test.ts）
import { REQUESTS_SLACK_MS } from '../../shared/agentRequests.ts'
import { eventKind } from '../../shared/events.ts'
import type { AgentRequest, AgentRequestItem, AgentRequestStatus, FeedRow } from '../../shared/types.ts'

/** 数える順（見出しに並べる順） */
const ORDER: readonly AgentRequestStatus[] = ['done', 'pending', 'held', 'failed']

/** 状態の語。`返答あり` は返答の行が来たというだけで、成果を確かめたという意味ではない */
export const REQUEST_STATUS_LABEL: Record<AgentRequestStatus, string> = { held: '預かり', pending: '返答待ち', done: '返答あり', failed: '失敗' }

/** 状態ごとの件数 */
export function requestCounts(items: readonly Pick<AgentRequestItem, 'status'>[]): Record<AgentRequestStatus, number> {
  const out: Record<AgentRequestStatus, number> = { held: 0, pending: 0, done: 0, failed: 0 }
  for (const i of items) out[i.status]++
  return out
}

/**
 * 見出しの 1 行。`3 件 · 返答あり 1 · 返答待ち 1 · 預かり 1`（0 件の状態は出さない）。
 * 返答ありでも返答の行が見つからないものは「返答あり」に数えず、`返答の行なし N` と別に書く（畳んだままで成果があるように見せない）
 */
export function requestSummary(r: Pick<AgentRequest, 'items'>): string {
  const lost = r.items.filter((i) => i.status === 'done' && !i.reply_ts).length
  const counts = requestCounts(r.items)
  counts.done -= lost
  return [`${r.items.length} 件`, ...ORDER.filter((s) => counts[s] > 0).map((s) => `${REQUEST_STATUS_LABEL[s]} ${counts[s]}`), ...(lost > 0 ? [`返答の行なし ${lost}`] : [])].join(' · ')
}

/**
 * 1 件の状態の語。返答ありでも**返答の行が見つからなければそう書く**（成果があるように見せない。飛び先も出さない）。
 * 預かりのまま止まったものは送っていないと書く
 */
export function requestItemLabel(i: Pick<AgentRequestItem, 'status' | 'reply_ts' | 'halted'>): string {
  if (i.status === 'done' && !i.reply_ts) return '返答あり（返答の行が見つかりません）'
  if (i.status === 'failed' && i.halted) return '失敗（送っていません）'
  return REQUEST_STATUS_LABEL[i.status]
}

/** 秒に丸める（行の `ts` は秒まで） */
const seconds = (s: string) => Math.floor(Date.parse(s) / 1000)

/**
 * 依頼のカードを置く場所。依頼したターン（`turn` = 始めた時刻）の**ターン完了の返答のバブルの下**に置く:
 * このセッションの行のうち、`turn` の秒より**後の秒**の最初のターン完了の行（`eventKind() === 'turn'`）。同じ秒は数えない
 * （行の時刻は秒までで、前のターンのターン完了の行と同じ秒に次のターンが始まりうる。依頼したターンは送るまでに 1 秒より長くかかる）。
 * いま回しているターン（`runningTurn`）の依頼と、ターン完了の行がまだ・見つからない依頼は `tail`（チャットの末尾）に置く。
 * 描いている最初の行より `REQUESTS_SLACK_MS` 以上前に始まったターンの依頼はどこにも置かない（窓の外。サーバも載せない）。
 * `rows` はこのセッションの行（古い順。別のセッションからの返答の行は混ぜない）
 */
export function placeRequests(requests: readonly AgentRequest[], rows: readonly FeedRow[], runningTurn = ''): { at: Map<string, AgentRequest[]>; tail: AgentRequest[] } {
  const at = new Map<string, AgentRequest[]>()
  const tail: AgentRequest[] = []
  const turns = rows.filter((r) => eventKind(r.event, r.text) === 'turn')
  const first = rows[0] ? Date.parse(rows[0].ts) : NaN
  for (const r of requests) {
    if (Number.isFinite(first) && Date.parse(r.turn) < first - REQUESTS_SLACK_MS) continue
    const start = seconds(r.turn)
    const anchor = r.turn === runningTurn || !Number.isFinite(start) ? undefined : turns.find((row) => seconds(row.ts) > start)
    if (!anchor) {
      tail.push(r)
      continue
    }
    const list = at.get(anchor.ts)
    if (list) list.push(r)
    else at.set(anchor.ts, [r])
  }
  return { at, tail }
}
