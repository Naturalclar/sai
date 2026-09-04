import { useState } from 'react'
import { hm } from './format'
import { Markdown } from './Markdown'
import { ThinkingBlock } from './ThinkingBlock'

// 折りたたむかは描画前の生の長さで見る（コードブロック1つで8行を超えても折りたたむ。今まで通り）
const isLong = (text: string) => text.length > 600 || text.split('\n').length > 8

interface Props {
  ts: string
  text: string
  markdown: boolean
  /** 待ちの行（許可待ち・質問待ち）。⏳ を付けて Markdown にせず出す */
  waiting?: boolean
  /** 待ちがもう解消している（後に行が来た）。薄く出す */
  resolved?: boolean
  /** そのターンの思考。渡されれば本文の上に折りたたんで出す（セッション画面だけ渡す） */
  thinking?: string
  /** 思考を最初から開いておく */
  thinkingOpen?: boolean
}

/** バブル1つ分の本文。長ければ折りたたんで「もっと見る」を付ける */
export function Message({ ts, text, markdown, waiting, resolved, thinking, thinkingOpen = false }: Props) {
  const [open, setOpen] = useState(false)
  const long = isLong(text)
  if (waiting) {
    return (
      <div className={`msg waiting${resolved ? ' resolved' : ''}`}>
        <span className="time">{hm(ts)}</span>
        <div className="body" title={resolved ? 'この待ちはもう解消している' : '人の答えを待って止まっている'}>⏳ {text || '人を待って止まっている'}</div>
      </div>
    )
  }
  return (
    <div className="msg">
      <span className="time">{hm(ts)}</span>
      {thinking && <ThinkingBlock text={thinking} openAll={thinkingOpen} />}
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
