// serve.py の API と1対1。形を変えるときは web/serve.py の aggregate() も一緒に

export type Agent = 'claude' | 'codex' | 'unknown'
export type SessionSource = 'payload' | 'rollout' | 'synth' | ''

export interface FeedRow {
  ts: string
  agent: Agent
  repo: string
  branch: string
  session: string
  session_source: SessionSource
  cwd: string
  event: string
  text: string
  first_user_text?: string
}

export interface SessionSummary {
  id: string
  start: string
  end: string
  date: string
  dates: string[]
  agent: Agent
  agents: Agent[]
  repo: string
  repos: string[]
  branch: string
  branches: string[]
  cwd: string
  turns: number
  title: string
  title_full: string
  session_source: SessionSource
  sources: SessionSource[]
  last_text: string
}

export interface Facets {
  repos: string[]
  agents: Agent[]
  dates: string[]
}

export interface SessionsResponse {
  rev: string
  days: number
  total: number
  sessions: SessionSummary[]
  filters: Facets
}

export interface SessionDetailResponse {
  rev: string
  session: SessionSummary
  rows: FeedRow[]
}

export interface FeedResponse {
  rev: string
  days: number
  rows: FeedRow[]
}

export interface SessionFilters {
  repo: string
  agent: string
  date: string
  days: string
}

export interface FeedFilters {
  repo: string
  days: string
}

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
