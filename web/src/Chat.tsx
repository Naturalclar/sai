import { useEffect, useRef } from 'react'
import type { ReactNode } from 'react'
import { entityId } from '../../shared/entity.ts'
import { AGENT_INITIAL, AGENT_LABEL, type FeedRow } from './api'
import { hm } from './format'
import { groupRows } from './chatGroups.ts'
import { Message } from './Message'

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
                  <Message key={u.key} ts={u.row.ts} text={u.text} markdown={u.speaker !== 'me'} waiting={u.waiting} resolved={u.resolved} />
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
