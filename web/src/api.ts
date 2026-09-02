// serve 側の実装は server/。型は shared/types.ts に1つだけ置いて両方から import する
import type { FeedFilters, FeedResponse, SessionDetailResponse, SessionFilters, SessionsResponse } from '../../shared/types.ts'

export type { Agent, FeedRow, SessionSource, SessionSummary, Facets, SessionFilters, FeedFilters } from '../../shared/types.ts'

async function getJSON<T>(url: string): Promise<T> {
  const res = await fetch(url, { cache: 'no-store' })
  if (!res.ok) throw new Error(`${res.status} ${url}`)
  return (await res.json()) as T
}

const qs = (params: object) => new URLSearchParams(Object.entries(params)).toString()

export const api = {
  sessions: (f: SessionFilters) => getJSON<SessionsResponse>(`/api/sessions?${qs(f)}`),
  session: (id: string, days = 90) =>
    getJSON<SessionDetailResponse>(`/api/sessions/${encodeURIComponent(id)}?days=${days}`),
  feed: (f: FeedFilters) => getJSON<FeedResponse>(`/api/feed?${qs(f)}`),
}

export const AGENT_LABEL: Record<string, string> = { claude: 'Claude Code', codex: 'Codex CLI', unknown: 'unknown' }
export const AGENT_INITIAL: Record<string, string> = { claude: 'C', codex: 'X', unknown: '?' }
