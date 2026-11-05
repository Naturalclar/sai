import { DOTS_STATE_LABEL } from '../../shared/dots.ts'
import type { DotsRequest } from '../../shared/dots.ts'
import { Avatar } from './Avatar'
import { DotsReply } from './DotsReply'
import { hm } from './format'

/** 人の投稿 1 つと、その状態・返答（#872）。投稿は打ったままの文字で出す */
export function DotsRequestItem({ request: r }: { request: DotsRequest }) {
  return (
    <>
      <div className="group dots-me">
        <Avatar kind="me" mark="私" />
        <div>
          <div className="gh">
            <span className="name">あなた</span>
            <span className="time" title={r.message.at}>
              {hm(r.message.at)}
            </span>
            <span className={`dots-state ${r.state}`} title={r.reason ?? ''}>
              {DOTS_STATE_LABEL[r.state]}
            </span>
          </div>
          <div className="msg">
            <div className="body">{r.message.text}</div>
            {r.reason && <div className="dots-reason">{r.reason}</div>}
          </div>
        </div>
      </div>
      {r.replies.map((m) => (
        <DotsReply key={`reply:${m.id}`} message={m} />
      ))}
    </>
  )
}
