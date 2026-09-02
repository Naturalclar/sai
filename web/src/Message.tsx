import { useState } from 'react'
import { hm } from './format'
import { Markdown } from './Markdown'

// 折りたたむかは描画前の生の長さで見る（コードブロック1つで8行を超えても折りたたむ。今まで通り）
const isLong = (text: string) => text.length > 600 || text.split('\n').length > 8

/** バブル1つ分の本文。長ければ折りたたんで「もっと見る」を付ける */
export function Message({ ts, text, markdown }: { ts: string; text: string; markdown: boolean }) {
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
