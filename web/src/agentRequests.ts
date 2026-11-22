// 依頼ごとの進み具合（#902）の、画面の文言と置き場所。DOM に依らないので node:test で回す（agentRequests.test.ts）
import { uncheckedCount } from '../../shared/agentResults.ts'
import { eventKind } from '../../shared/events.ts'
import type { AgentRequest, AgentRequestItem, AgentRequestResult, AgentRequestStatus, FeedRow } from '../../shared/types.ts'

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
 * 見出しの 1 行。`3 件 · 成果確認待ち 1 · 返答あり 1 · 返答待ち 1 · 預かり 1`（0 件の状態は出さない）。
 * 返答ありでも返答の行が見つからないものは「返答あり」に数えず、`返答の行なし N` と別に書く（畳んだままで成果があるように見せない）。
 * 成果確認待ち（#903）は人が「確認済み」にするまで数える（読んだだけでは減らない）
 */
export function requestSummary(r: Pick<AgentRequest, 'items'>): string {
  const unchecked = uncheckedCount(r.items)
  const lost = r.items.filter((i) => i.status === 'done' && !i.reply_ts).length
  const counts = requestCounts(r.items)
  counts.done -= lost
  return [`${r.items.length} 件`, ...(unchecked > 0 ? [`成果確認待ち ${unchecked}`] : []), ...ORDER.filter((s) => counts[s] > 0).map((s) => `${REQUEST_STATUS_LABEL[s]} ${counts[s]}`), ...(lost > 0 ? [`返答の行なし ${lost}`] : [])].join(' · ')
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

/** 成果の状態の語（#903）。確認済みは SAI の上の印だけ（許可・承認・マージではない） */
export function resultLabel(r: Pick<AgentRequestResult, 'checked_at' | 'revised'>): string {
  const what = r.revised ? '直したあとの成果' : '成果'
  return r.checked_at ? `${what}: 確認済み` : `${what}: 確認待ち`
}

/** 秒に丸める（行の `ts` は秒まで） */
const seconds = (s: string) => Math.floor(Date.parse(s) / 1000)

/**
 * 依頼のカードを置く場所。依頼したターン（`turn` = 始めた時刻）の**ターン完了の返答のバブルの下**に置く:
 * このセッションの行のうち、`turn` の秒より**後の秒**の最初のターン完了の行（`eventKind() === 'turn'`）。同じ秒は数えない
 * （行の時刻は秒までで、前のターンのターン完了の行と同じ秒に次のターンが始まりうる。依頼したターンは送るまでに 1 秒より長くかかる）。
 * いま回しているターン（`runningTurn`）の依頼と、ターン完了の行がまだ・見つからない依頼は `tail`（チャットの末尾）に置く。
 * 返答のバブルを描いていないターンの依頼はサーバが載せない（線は `requestsWindowStart()`）ので、ここでは絞らない。
 * `rows` はこのセッションの行（古い順。別のセッションからの返答の行は混ぜない）
 */
export function placeRequests(requests: readonly AgentRequest[], rows: readonly FeedRow[], runningTurn = ''): { at: Map<string, AgentRequest[]>; tail: AgentRequest[] } {
  const at = new Map<string, AgentRequest[]>()
  const tail: AgentRequest[] = []
  const turns = rows.filter((r) => eventKind(r.event, r.text) === 'turn')
  for (const r of requests) {
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

/**
 * このバブルの下に依頼のカードを出すなら、その鍵（行の `ts`）。出さなければ空（#902）。
 * 出すのはこのセッションのターン完了の返答のバブルだけ（別のセッションからの返答・待ちのバブル・自分の入力には出さない）。
 * 同じ `ts` のバブルが 2 つあっても（補った行と本物の行など）最初の 1 つにだけ出す（`shown` に覚える。描くたびに作り直す）
 */
export function afterTurnKey(u: { waiting?: boolean; reply?: unknown; row: Pick<FeedRow, 'ts' | 'event' | 'text'> }, side: 'me' | 'agent', shown: Set<string>): string {
  if (side !== 'agent' || u.waiting || u.reply || eventKind(u.row.event, u.row.text) !== 'turn' || shown.has(u.row.ts)) return ''
  shown.add(u.row.ts)
  return u.row.ts
}
