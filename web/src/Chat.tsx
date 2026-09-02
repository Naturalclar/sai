import { useEffect, useMemo, useRef } from 'react'
import type { ReactNode } from 'react'
import { entityId } from '../../shared/entity.ts'
import type { FeedRow, SessionSummary } from './api'
import { hm } from './format'
import { groupRows, speakerLabel } from './chatGroups.ts'
import { Message } from './Message'

const NO_SESSIONS: never[] = []

interface Props {
  rows: FeedRow[]
  showChannel: boolean
  /** 発言者の表示名・アイコンを引く元（SessionSummary.meta）。セッション画面はその1件、フィードはサイドバーの一覧 */
  sessions?: SessionSummary[]
  /** 末尾に足す仮の要素（送信中の返信など）。行と同じく最下部追従の対象 */
  trailer?: ReactNode
}

export function Chat({ rows, showChannel, sessions = NO_SESSIONS, trailer }: Props) {
  const ref = useRef<HTMLDivElement>(null)
  const stickToBottom = useRef(true)
  // エンティティID → meta。バブルの見出しは行しか持っていないので、entityId で引く
  const metaById = useMemo(() => new Map(sessions.filter((s) => s.meta).map((s) => [s.id, s.meta!] as const)), [sessions])

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
          {day.groups.map((g) => {
            const id = entityId(g.session, g.repo, g.firstTs)
            const who = speakerLabel(g.speaker, metaById.get(id))
            return (
              <div className="group" key={`${g.speaker}:${g.session}:${g.firstTs}`}>
                <div className={`avatar ${g.speaker}`}>{who.mark}</div>
                <div>
                  <div className="gh">
                    <span className="name">{who.name}</span>
                    {showChannel && (
                      <a className="ch" href={`#/s/${encodeURIComponent(id)}`} title={g.session}>#{g.repo}</a>
                    )}
                    {g.branch && <span className="branch">{g.branch}</span>}
                    <span className="time">{hm(g.firstTs)}</span>
                  </div>
                  {g.items.map((u) => (
                    // 自分の入力は Markdown にしない（打ったままを出す）。エージェントの返答は Markdown
                    <Message key={u.key} ts={u.row.ts} text={u.text} markdown={u.speaker !== 'me'} waiting={u.waiting} resolved={u.resolved} />
                  ))}
                </div>
              </div>
            )
          })}
        </div>
      ))}
      {trailer}
    </div>
  )
}
