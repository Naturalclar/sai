import type { DotsConversation } from '../../shared/dots.ts'
import { DotsReply } from './DotsReply'
import { DotsRequestItem } from './DotsRequestItem'
import { dotsTitle } from './dotsLog.ts'
import { hm, ymd } from './format'

interface Props {
  conversation: DotsConversation
  /** 入力欄の送り先がこの会話か */
  selected: boolean
  onSelect: () => void
}

/** dots との会話 1 つ（#872）。見出しに題名と始めた時刻、その下に依頼ごとの投稿と返答 */
export function DotsConversationBlock({ conversation: c, selected, onSelect }: Props) {
  return (
    <div className={`dots-conv${selected ? ' selected' : ''}`}>
      <div className="dots-conv-head">
        <span className="dots-conv-title">{dotsTitle(c)}</span>
        <span className="time" title={c.started_at}>
          {ymd(c.started_at)} {hm(c.started_at)}
        </span>
        {c.imported ? (
          // dots が書き置いた記録（#878）。SAI からは続けて送れない
          <span className="dots-conv-imported" title="dots が書き置いた記録から取り込んだ会話。抜けや書き換えがありえます">ChatGPT で話した記録</span>
        ) : selected ? (
          <span className="dots-conv-here">この会話に続けて送ります</span>
        ) : (
          <button type="button" className="dots-conv-continue" onClick={onSelect}>
            この会話に続ける
          </button>
        )}
      </div>
      {c.requests.map((r) => (
        <DotsRequestItem key={`req:${r.message.id}`} request={r} />
      ))}
      {c.orphans.map((m) => (
        <DotsReply key={`orphan:${m.id}`} message={m} orphan />
      ))}
    </div>
  )
}
