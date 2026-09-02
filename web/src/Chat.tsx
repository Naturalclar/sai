import { useEffect, useRef, useState } from 'react'
import { entityId } from '../../shared/entity.ts'
import { AGENT_INITIAL, AGENT_LABEL, type FeedRow } from './api'
import { dayLabel, hm, minutesBetween, ymd } from './format'

interface Group {
  agent: string
  repo: string
  branch: string
  session: string
  firstTs: string
  lastTs: string
  rows: { row: FeedRow; index: number }[]
}

const GROUP_GAP_MIN = 10

/** Slack と同じ: 同じ発言者（agent+session）が10分以内に続けば1つにまとめる */
function groupRows(rows: FeedRow[]): { day: string; label: string; groups: Group[] }[] {
  const days: { day: string; label: string; groups: Group[] }[] = []
  let current: Group | null = null
  rows.forEach((row, index) => {
    const day = ymd(row.ts)
    let bucket = days[days.length - 1]
    if (!bucket || bucket.day !== day) {
      bucket = { day, label: dayLabel(row.ts), groups: [] }
      days.push(bucket)
      current = null
    }
    const same =
      current &&
      current.agent === row.agent &&
      current.repo === row.repo &&
      current.session === row.session &&
      minutesBetween(current.lastTs, row.ts) < GROUP_GAP_MIN
    if (same && current) {
      current.rows.push({ row, index })
      current.lastTs = row.ts
    } else {
      current = { agent: row.agent, repo: row.repo, branch: row.branch, session: row.session, firstTs: row.ts, lastTs: row.ts, rows: [{ row, index }] }
      bucket.groups.push(current)
    }
  })
  return days
}

export function Chat({ rows, showChannel }: { rows: FeedRow[]; showChannel: boolean }) {
  const ref = useRef<HTMLDivElement>(null)
  const stickToBottom = useRef(true)

  // 最下部を見ていたときだけ、更新後も最下部に追従する
  useEffect(() => {
    const el = ref.current
    if (el && stickToBottom.current && rows.length > 0) el.scrollTop = el.scrollHeight
  }, [rows])

  const onScroll = () => {
    const el = ref.current
    if (el) stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40
  }

  if (rows.length === 0) return <div className="empty">まだ何もありません</div>

  return (
    <div className="chat" ref={ref} onScroll={onScroll}>
      {groupRows(rows).map((day) => (
        <div key={day.day}>
          <div className="day"><span>{day.label}</span></div>
          {day.groups.map((g) => (
            <div className="group" key={`${g.session}:${g.firstTs}`}>
              <div className={`avatar ${g.agent}`}>{AGENT_INITIAL[g.agent] ?? '?'}</div>
              <div>
                <div className="gh">
                  <span className="name">{AGENT_LABEL[g.agent] ?? g.agent}</span>
                  {showChannel && (
                    <a className="ch" href={`#/s/${encodeURIComponent(entityId(g.session, g.repo, g.firstTs))}`} title={g.session}>#{g.repo}</a>
                  )}
                  {g.branch && <span className="branch">{g.branch}</span>}
                  <span className="time">{hm(g.firstTs)}</span>
                </div>
                {g.rows.map(({ row, index }) => <Message key={`${row.ts}:${index}`} row={row} />)}
              </div>
            </div>
          ))}
        </div>
      ))}
    </div>
  )
}

const isLong = (text: string) => text.length > 600 || text.split('\n').length > 8

function Message({ row }: { row: FeedRow }) {
  const [open, setOpen] = useState(false)
  const text = row.text ?? ''
  const long = isLong(text)
  return (
    <div className="msg">
      <span className="time">{hm(row.ts)}</span>
      {text ? (
        <div className={`body${long && !open ? ' clamped' : ''}`}>{text}</div>
      ) : (
        <div className="empty-text">(本文なし)</div>
      )}
      {long && (
        <button type="button" className="more" onClick={() => setOpen((v) => !v)}>
          {open ? '折りたたむ' : 'もっと見る'}
        </button>
      )}
    </div>
  )
}
