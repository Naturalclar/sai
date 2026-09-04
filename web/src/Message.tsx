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
  /** 一言版（digest）。あればこれを本文にして、元の text は「詳細」で開く */
  summary?: string
}

/** バブル1つ分の本文。長ければ折りたたんで「もっと見る」を付ける */
export function Message({ ts, text, markdown, waiting, resolved, thinking, thinkingOpen = false, summary }: Props) {
  const [open, setOpen] = useState(false)
  // 一言があるとき、元の本文（詳細）を開いているか
  const [details, setDetails] = useState(false)
  const long = isLong(text)
  if (waiting) {
    return (
      <div className={`msg waiting${resolved ? ' resolved' : ''}`}>
        <span className="time">{hm(ts)}</span>
        <div className="body" title={resolved ? 'この待ちはもう解消している' : '人の答えを待って止まっている'}>⏳ {text || '人を待って止まっている'}</div>
      </div>
    )
  }
  if (summary && text) {
    // 一言 + 「詳細」。詳細を開いたら元の本文を今までどおり（Markdown、長ければ折りたたみ）
    return (
      <div className="msg">
        <span className="time">{hm(ts)}</span>
        {thinking && <ThinkingBlock text={thinking} openAll={thinkingOpen} />}
        <div className="summary">
          <span className="line">{summary}</span>
          <button type="button" className="linkish details-toggle" onClick={() => setDetails((v) => !v)} aria-expanded={details}>
            {details ? '詳細を閉じる' : '詳細'}
          </button>
        </div>
        {details && (
          <div className="details">
            <div className={`body${long && !open ? ' clamped' : ''}`}>{markdown ? <Markdown text={text} /> : text}</div>
            {long && (
              <button type="button" className="more" onClick={() => setOpen((v) => !v)}>
                {open ? '折りたたむ' : 'もっと見る'}
              </button>
            )}
          </div>
        )}
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
