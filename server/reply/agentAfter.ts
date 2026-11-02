// 頼んだ件の「その後」（#827）を、送り元の次のターンの頭に添えるための材料集め。組み方は shared/agentAfter.ts の `afterTurns()`。
// `createApp()` の値は引数で受け、`app.ts` を import しない（#807 の分け方）
import { AFTER_KEEP_MS, afterTurns, askRefs } from '../../shared/agentAfter.ts'
import type { AfterClosed } from '../../shared/agentAfter.ts'
import { replierName } from '../../shared/agentMessages.ts'
import { githubRepoOf } from '../../shared/prs.ts'
import type { FeedRow, SessionSummary } from '../../shared/types.ts'
import type { PrBrowser } from '../git/prs.ts'
import type { AgentMessages } from './agentMessages.ts'

/** 頼んだ件が閉じたかを `gh` に聞いて待つ上限（送り元のターンを起こすのを待たせるので短く）。間に合わなければ開いている扱い */
export const AFTER_GH_WAIT_MS = 3000

/** 添えたあとに書くこと（`AgentMessages.setAfter()` の形）と、ターンが失敗したときに戻す前の値 */
export interface AfterPlan {
  block: string
  turns: number
  next: { message_id: string; after_at?: string; after_done?: true }[]
  prev: { message_id: string; after_at?: string; after_done?: true }[]
}

export function createAfterTurns(deps: {
  agents: AgentMessages
  /** 行（古い順。落ちた返答を補ったものも含む `rowsNow()`） */
  rows: () => Promise<readonly FeedRow[]>
  sessions: () => Promise<readonly SessionSummary[]>
  /** そのターンの一言を引く道具を用意する（一言を切っているセッション・無いターンは空を返す） */
  lines: () => Promise<(entity: string, row: FeedRow) => string>
  prs: PrBrowser
  waitMs?: number
}): (from: string) => Promise<AfterPlan> {
  const none: AfterPlan = { block: '', turns: 0, next: [], prev: [] }
  return async (from) => {
    const sent = deps.agents.sentSince(from, Date.now() - AFTER_KEEP_MS)
    // 別のリポジトリの相手には添えない（#827 の決めたこと 4。送ったときの印で見る）
    const asks = sent.filter((m) => !m.far && !m.after_done)
    if (asks.length === 0) return none
    const sessions = await deps.sessions()
    const byId = new Map(sessions.map((s) => [s.id, s]))
    const live = asks.filter((m) => byId.has(m.to))
    if (live.length === 0) return none
    // 頼んだ番号が閉じたか。相手のリポジトリ（remote）で引く。待つのは `waitMs` まで（間に合わなければ開いている扱い。3 日で止まる）
    const closed = new Map<number, AfterClosed>()
    if (deps.prs.refState) {
      const look = live.flatMap((m) => {
        const repo = githubRepoOf(byId.get(m.to)?.remote)
        return repo ? askRefs(m.text).map((n) => ({ repo, n })) : []
      })
      const uniq = [...new Map(look.map((x) => [`${x.repo}#${x.n}`, x])).values()]
      const got = await Promise.race([
        Promise.all(uniq.map(async (x) => ({ n: x.n, state: await deps.prs.refState!(x.repo, x.n).catch(() => null) }))),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), deps.waitMs ?? AFTER_GH_WAIT_MS).unref()),
      ])
      for (const g of got ?? []) if (g.state?.closed_at) closed.set(g.n, { kind: g.state.kind, at: g.state.closed_at })
    }
    const [rows, lineOf] = await Promise.all([deps.rows(), deps.lines()])
    const result = afterTurns(
      live.map((m) => ({ message_id: m.message_id, to: m.to, to_name: replierName(byId.get(m.to)!), text: m.text, ...(m.after_at ? { after_at: m.after_at } : {}) })),
      rows,
      { lineOf, closed, ownIds: new Set(deps.agents.sentSince(from, 0).map((m) => m.message_id)) },
    )
    if (!result.block && result.updates.length === 0) return none
    const prev = live.filter((m) => result.updates.some((u) => u.message_id === m.message_id)).map((m) => ({ message_id: m.message_id, ...(m.after_at ? { after_at: m.after_at } : {}), ...(m.after_done ? { after_done: m.after_done } : {}) }))
    const next = result.updates.map((u) => ({ message_id: u.message_id, ...(u.after_at ? { after_at: u.after_at } : {}), ...(u.done ? { after_done: true as const } : {}) }))
    return { block: result.block, turns: result.turns, next, prev }
  }
}
