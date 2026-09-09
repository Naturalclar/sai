import { useState } from 'react'
import { hm } from './format'
import { Markdown } from './Markdown'
import { Inlines } from './Inlines'
import { linkifyRefs } from '../../shared/refs.ts'
import { ThinkingBlock } from './ThinkingBlock'
import { useReveal } from './useReveal'
import { AttachedImages } from './AttachedImages'
import { splitAttachments } from '../../shared/attachments.ts'

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
  /** 一言の中の #123 の向き先（行の remote）。無ければ番号はリンクにしない */
  remote?: string
  /** 一言の中の PGR-123 の向き先（設定の Linear の workspace）。空ならリンクにしない */
  linear?: string
  /** このターンからモデルが変わった。そのモデル名を小さく出す */
  model?: string
}

/** バブル1つ分の本文。長ければ折りたたんで「もっと見る」を付ける */
export function Message({ ts, text: raw, markdown, waiting, resolved, thinking, thinkingOpen = false, summary, model, remote, linear }: Props) {
  // 自分の入力に添えた画像は、パスの文字列ではなくサムネイルで出す（本文の末尾に足してある。shared/attachments.ts）
  const { body: text, urls } = markdown ? { body: raw, urls: [] as string[] } : splitAttachments(raw)
  const [open, setOpen] = useState(false)
  // 一言があるとき、元の本文（詳細）を開いているか
  const [details, setDetails] = useState(false)
  const long = isLong(text)
  // 開いたら中身が見えるところまでスクロールする（#119）。詳細は .details、「もっと見る」は本文そのもの
  const [detailsRef, summaryRef] = useReveal<HTMLDivElement, HTMLDivElement>(details)
  const [bodyRef, moreRef] = useReveal<HTMLDivElement, HTMLButtonElement>(open)
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
        <div className="summary" ref={summaryRef}>
          {/* 一言の中の URL・#123・PGR-123 はリンクにする（shared/refs.ts）。HTML 文字列は作らない */}
          <span className="line"><Inlines nodes={linkifyRefs(summary, { remote, linear })} /></span>
          <button type="button" className="linkish details-toggle" onClick={() => setDetails((v) => !v)} aria-expanded={details}>
            {details ? '詳細を閉じる' : '詳細'}
          </button>
        </div>
        {details && (
          <div className="details" ref={detailsRef}>
            <div className={`body${long && !open ? ' clamped' : ''}`} ref={bodyRef}>{markdown ? <Markdown text={text} /> : text}</div>
            {long && (
              <button type="button" className="more" onClick={() => setOpen((v) => !v)} ref={moreRef}>
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
      {model && <span className="tag model" title="このターンからモデルが変わった">{model}</span>}
      {thinking && <ThinkingBlock text={thinking} openAll={thinkingOpen} />}
      {text ? (
        <div className={`body${long && !open ? ' clamped' : ''}`} ref={bodyRef}>{markdown ? <Markdown text={text} /> : text}</div>
      ) : (
        urls.length === 0 && <div className="empty-text">(本文なし)</div>
      )}
      <AttachedImages urls={urls} />
      {long && (
        <button type="button" className="more" onClick={() => setOpen((v) => !v)} ref={moreRef}>
          {open ? '折りたたむ' : 'もっと見る'}
        </button>
      )}
    </div>
  )
}
