import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { entityId } from '../../shared/entity.ts'
import { AGENT_INITIAL, AGENT_LABEL, type FeedRow } from './api'
import { dayLabel, hm, minutesBetween, ymd } from './format'
import { Markdown } from './Markdown'

/** 発言者。自分（ターンの入力）か、エージェント */
type Speaker = 'me' | FeedRow['agent']

/**
 * 1つのバブル。1行（= 1ターン）は「自分の入力（user_text）」と「エージェントの返答（text）」の
 * 2つの発言に展開する。user_text が無い行（古い JSONL など）はエージェントの発言だけ
 */
interface Utterance {
  speaker: Speaker
  row: FeedRow
  text: string
  key: string
}

interface Group {
  speaker: Speaker
  repo: string
  branch: string
  session: string
  firstTs: string
  lastTs: string
  items: Utterance[]
}

const GROUP_GAP_MIN = 10

function toUtterances(rows: FeedRow[]): Utterance[] {
  const out: Utterance[] = []
  rows.forEach((row, index) => {
    const mine = row.user_text ?? ''
    if (mine.trim()) out.push({ speaker: 'me', row, text: mine, key: `${row.ts}:${index}:me` })
    out.push({ speaker: row.agent, row, text: row.text ?? '', key: `${row.ts}:${index}` })
  })
  return out
}

/** Slack と同じ: 同じ発言者（speaker+session）が10分以内に続けば1つにまとめる */
function groupRows(rows: FeedRow[]): { day: string; label: string; groups: Group[] }[] {
  const days: { day: string; label: string; groups: Group[] }[] = []
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

/** trailer は末尾に足す仮の要素（送信中の返信など）。行と同じく最下部追従の対象 */
export function Chat({ rows, showChannel, trailer }: { rows: FeedRow[]; showChannel: boolean; trailer?: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null)
  const stickToBottom = useRef(true)

  // 最下部を見ていたときだけ、更新後も最下部に追従する
  useEffect(() => {
    const el = ref.current
    if (el && stickToBottom.current && (rows.length > 0 || trailer)) el.scrollTop = el.scrollHeight
  }, [rows, trailer])

  const onScroll = () => {
    const el = ref.current
    if (el) stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40
  }

  if (rows.length === 0 && !trailer) return <div className="empty">まだ何もありません</div>

  return (
    <div className="chat" ref={ref} onScroll={onScroll}>
      {groupRows(rows).map((day) => (
        <div key={day.day}>
          <div className="day"><span>{day.label}</span></div>
          {day.groups.map((g) => (
            <div className="group" key={`${g.speaker}:${g.session}:${g.firstTs}`}>
              <div className={`avatar ${g.speaker}`}>{g.speaker === 'me' ? '私' : (AGENT_INITIAL[g.speaker] ?? '?')}</div>
              <div>
                <div className="gh">
                  <span className="name">{g.speaker === 'me' ? 'あなた' : (AGENT_LABEL[g.speaker] ?? g.speaker)}</span>
                  {showChannel && (
                    <a className="ch" href={`#/s/${encodeURIComponent(entityId(g.session, g.repo, g.firstTs))}`} title={g.session}>#{g.repo}</a>
                  )}
                  {g.branch && <span className="branch">{g.branch}</span>}
                  <span className="time">{hm(g.firstTs)}</span>
                </div>
                {g.items.map((u) => (
                  // 自分の入力は Markdown にしない（打ったままを出す）。エージェントの返答は Markdown
                  <Message key={u.key} ts={u.row.ts} text={u.text} markdown={u.speaker !== 'me'} />
                ))}
              </div>
            </div>
          ))}
        </div>
      ))}
      {trailer}
    </div>
  )
}

/** 送信した返信の仮バブル。フックで行が届いたら SessionView が消す（届いた行の user_text が本物になる） */
export function PendingBubble({ text }: { text: string }) {
  return (
    <div className="group pending">
      <div className="avatar me">私</div>
      <div>
        <div className="gh">
          <span className="name">あなた</span>
          <span className="time">送信中…</span>
        </div>
        <div className="msg">
          <div className="body">{text}</div>
        </div>
      </div>
    </div>
  )
}

// 折りたたむかは描画前の生の長さで見る（コードブロック1つで8行を超えても折りたたむ。今まで通り）
const isLong = (text: string) => text.length > 600 || text.split('\n').length > 8

function Message({ ts, text, markdown }: { ts: string; text: string; markdown: boolean }) {
  const [open, setOpen] = useState(false)
  const long = isLong(text)
  return (
    <div className="msg">
      <span className="time">{hm(ts)}</span>
      {text ? (
        <div className={`body${long && !open ? ' clamped' : ''}`}>{markdown ? <Markdown text={text} /> : text}</div>
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
