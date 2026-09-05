// 行 → セッションの集計。エンティティの単位は (セッション, リポジトリ)。キーは shared/entity.ts。
import { entityId, localDate } from '../shared/entity.ts'
import { eventKind } from '../shared/events.ts'
import type { Agent, Facets, FeedRow, SessionSource, SessionSummary } from '../shared/types.ts'

export { entityId, localDate, TIME_ZONE } from '../shared/entity.ts'

export const TITLE_LEN = 60
export const TITLE_FULL_LEN = 300

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

/**
 * セッションのタイトル。一番新しい user_text の1行目。返信や端末での続きの指示があるたびに、最後の入力に追従する。
 * user_text が1行も無ければ first_user_text（毎行に載っているので窓から1行目が落ちても残る）、それも無ければ最初の text の1行目
 */
export function sessionTitle(items: FeedRow[]): string {
  for (let i = items.length - 1; i >= 0; i--) {
    const t = items[i]!.user_text
    if (t?.trim()) return firstLine(t)
  }
  for (const row of items) {
    if (row.first_user_text?.trim()) return firstLine(row.first_user_text)
  }
  return firstLine(items[0]?.text ?? '')
}

/** 窓の中の一番新しい行の記録側の版。v の無い行は 1（試作か古い record.py）、行が無ければ 0。入力は ts 昇順 */
export function recordVersionOf(rows: FeedRow[]): number {
  const last = rows[rows.length - 1]
  if (!last) return 0
  return typeof last.v === 'number' && last.v >= 1 ? last.v : 1
}

/** 行を (セッション, リポジトリ) 単位にまとめる。入力は ts 昇順であること。新しい順に返す */
export function aggregate(rows: FeedRow[]): SessionSummary[] {
  const groups = new Map<string, FeedRow[]>()
  for (const row of rows) {
    const id = entityId(row.session ?? '', row.repo ?? '', String(row.ts ?? ''))
    const list = groups.get(id)
    if (list) list.push(row)
    else groups.set(id, [row])
  }

  const sessions: SessionSummary[] = []
  for (const [id, items] of groups) {
    const first = items[0]!
    const last = items[items.length - 1]!
    const repos = orderedUnique(items.map((r) => r.repo ?? ''))
    const branches = orderedUnique(items.map((r) => r.branch ?? ''))
    const agents = orderedUnique(items.map((r) => (r.agent ?? 'unknown') as Agent))
    const sources = orderedUnique(items.map((r) => (r.session_source ?? '') as SessionSource))

    const titleFull = sessionTitle(items)
    // ターンはターン完了の行だけ。待ち（PermissionRequest など）と再開（UserPromptSubmit）は数えないし、最後の発言にもしない
    const turnRows = items.filter((r) => eventKind(r.event) === 'turn')
    const lastTurn = turnRows[turnRows.length - 1]
    // 最後の行が待ちなら、まだ人を待っている。後にターン完了か再開が来ていれば解消
    const waiting = eventKind(last.event) === 'waiting' ? (last.text ?? '') : ''
    // モデルはターン完了の行だけが持つ。途中で変わっていれば全部（出てきた順）、表示は一番新しい行のもの
    const models = orderedUnique(turnRows.map((r) => (r.model ?? '').trim()).filter(Boolean))
    const lastModelRow = [...turnRows].reverse().find((r) => r.model?.trim())

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
      turns: turnRows.length,
      waiting,
      title: clip(titleFull, TITLE_LEN),
      title_full: clip(titleFull, TITLE_FULL_LEN),
      session_source: sources.includes('synth') ? 'synth' : (sources[sources.length - 1] ?? ''),
      sources,
      last_text: clip(firstLine(lastTurn?.text ?? ''), 120),
      last_turn_ts: lastTurn?.ts ?? '',
      model: lastModelRow?.model?.trim() ?? '',
      models,
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
