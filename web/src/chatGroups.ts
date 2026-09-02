// チャットの行をバブルの塊にまとめる。DOM に依存しないので node:test で回す（chatGroups.test.ts）
import type { FeedRow } from '../../shared/types.ts'
import { dayLabel, minutesBetween, ymd } from './format.ts'

/** 発言者。自分（ターンの入力）か、エージェント */
export type Speaker = 'me' | FeedRow['agent']

/**
 * 1つのバブル。1行（= 1ターン）は「自分の入力（user_text）」と「エージェントの返答（text）」の
 * 2つの発言に展開する。user_text が無い行（古い JSONL など）はエージェントの発言だけ
 */
export interface Utterance {
  speaker: Speaker
  row: FeedRow
  text: string
  key: string
}

export interface Group {
  speaker: Speaker
  repo: string
  branch: string
  session: string
  firstTs: string
  lastTs: string
  items: Utterance[]
}

export interface DayGroups {
  day: string
  label: string
  groups: Group[]
}

const GROUP_GAP_MIN = 10

export function toUtterances(rows: FeedRow[]): Utterance[] {
  const out: Utterance[] = []
  rows.forEach((row, index) => {
    const mine = row.user_text ?? ''
    if (mine.trim()) out.push({ speaker: 'me', row, text: mine, key: `${row.ts}:${index}:me` })
    out.push({ speaker: row.agent, row, text: row.text ?? '', key: `${row.ts}:${index}` })
  })
  return out
}

/** Slack と同じ: 同じ発言者（speaker+session）が10分以内に続けば1つにまとめる */
export function groupRows(rows: FeedRow[]): DayGroups[] {
  const days: DayGroups[] = []
  let current: Group | null = null
  for (const u of toUtterances(rows)) {
    const { row } = u
    const day = ymd(row.ts)
    let bucket = days[days.length - 1]
    if (!bucket || bucket.day !== day) {
      bucket = { day, label: dayLabel(row.ts), groups: [] }
      days.push(bucket)
      current = null
    }
    const same =
      current &&
      current.speaker === u.speaker &&
      current.repo === row.repo &&
      current.session === row.session &&
      minutesBetween(current.lastTs, row.ts) < GROUP_GAP_MIN
    if (same && current) {
      current.items.push(u)
      current.lastTs = row.ts
    } else {
      current = { speaker: u.speaker, repo: row.repo, branch: row.branch, session: row.session, firstTs: row.ts, lastTs: row.ts, items: [u] }
      bucket.groups.push(current)
    }
  }
  return days
}
