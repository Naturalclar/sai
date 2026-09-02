// 行 → セッションの集計。
import type { Agent, Facets, FeedRow, SessionSource, SessionSummary } from '../shared/types.ts'

export const TITLE_LEN = 60
export const TITLE_FULL_LEN = 300
export const TIME_ZONE = 'Asia/Tokyo'

const dateFmt = new Intl.DateTimeFormat('en-CA', {
  timeZone: TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
})

/** ts を Asia/Tokyo の YYYY-MM-DD にする。parse できなければ先頭10文字 */
export function localDate(ts: string): string {
  const d = new Date(ts)
  return Number.isNaN(d.getTime()) ? ts.slice(0, 10) : dateFmt.format(d)
}

/** 今日（Asia/Tokyo）から days 日ぶんの YYYY-MM-DD を新しい順に */
export function recentDates(days: number, now: Date = new Date()): string[] {
  const today = localDate(now.toISOString())
  const base = new Date(`${today}T00:00:00Z`)
  return Array.from({ length: days }, (_, i) => {
    const d = new Date(base)
    d.setUTCDate(d.getUTCDate() - i)
    return d.toISOString().slice(0, 10)
  })
}

export function firstLine(text: string): string {
  for (const line of (text ?? '').split('\n')) {
    const t = line.trim()
    if (t) return t
  }
  return ''
}

/** Python の len() と同じくコードポイントで数える */
export function clip(text: string, size: number): string {
  const chars = Array.from(text)
  return chars.length <= size ? text : chars.slice(0, size - 1).join('') + '…'
}

function orderedUnique<T>(values: Iterable<T>): T[] {
  const seen: T[] = []
  for (const v of values) if (!seen.includes(v)) seen.push(v)
  return seen
}

/** 行をセッション単位にまとめる。入力は ts 昇順であること。新しい順に返す */
export function aggregate(rows: FeedRow[]): SessionSummary[] {
  const groups = new Map<string, FeedRow[]>()
  for (const row of rows) {
    const session = row.session || `unknown-${row.repo ?? ''}-${localDate(String(row.ts ?? ''))}`
    const list = groups.get(session)
    if (list) list.push(row)
    else groups.set(session, [row])
  }

  const sessions: SessionSummary[] = []
  for (const [id, items] of groups) {
    const first = items[0]!
    const last = items[items.length - 1]!
    const repos = orderedUnique(items.map((r) => r.repo ?? ''))
    const branches = orderedUnique(items.map((r) => r.branch ?? ''))
    const agents = orderedUnique(items.map((r) => (r.agent ?? 'unknown') as Agent))
    const sources = orderedUnique(items.map((r) => (r.session_source ?? '') as SessionSource))

    let titleFull = ''
    for (const row of items) {
      if (row.first_user_text?.trim()) {
        titleFull = firstLine(row.first_user_text)
        break
      }
    }
    if (!titleFull) titleFull = firstLine(first.text ?? '')

    sessions.push({
      id,
      start: first.ts,
      end: last.ts,
      date: localDate(first.ts),
      dates: orderedUnique(items.map((r) => localDate(r.ts))),
      agent: agents[agents.length - 1] ?? 'unknown',
      agents,
      repo: repos[repos.length - 1] ?? '',
      repos: repos.filter(Boolean),
      branch: branches[branches.length - 1] ?? '',
      branches: branches.filter(Boolean),
      cwd: last.cwd ?? '',
      turns: items.length,
      title: clip(titleFull, TITLE_LEN),
      title_full: clip(titleFull, TITLE_FULL_LEN),
      session_source: sources.includes('synth') ? 'synth' : (sources[sources.length - 1] ?? ''),
      sources,
      last_text: clip(firstLine(last.text ?? ''), 120),
    })
  }
  sessions.sort((a, b) => (a.end < b.end ? 1 : a.end > b.end ? -1 : 0))
  return sessions
}

export function filterSessions(sessions: SessionSummary[], repo: string, agent: string, date: string): SessionSummary[] {
  let result = sessions
  if (repo) result = result.filter((s) => s.repos.includes(repo))
  if (agent) result = result.filter((s) => s.agents.includes(agent as Agent))
  if (date) result = result.filter((s) => s.dates.includes(date))
  return result
}

export function facets(sessions: SessionSummary[]): Facets {
  const repos = new Set<string>()
  const agents = new Set<Agent>()
  const dates = new Set<string>()
  for (const s of sessions) {
    for (const r of s.repos) repos.add(r)
    for (const a of s.agents) agents.add(a)
    for (const d of s.dates) dates.add(d)
  }
  return {
    repos: [...repos].sort(),
    agents: [...agents].sort(),
    dates: [...dates].sort().reverse(),
  }
}
