import { useState } from 'react'
import { hm } from './format'
import { Markdown } from './Markdown'
import { Inlines } from './Inlines'
import { linkifyRefs } from '../../shared/refs.ts'
import { ThinkingBlock } from './ThinkingBlock'
import { useReveal } from './useReveal'
import { AttachedImages } from './AttachedImages'
import { splitAttachments } from '../../shared/attachments.ts'
import { DiffButton, type DiffButtonProps } from './DiffButton'
import { SourceImages } from './SourceImages'
import { ImageSourceContext } from './imageContext'
import { QuestionPreview } from './QuestionPreview'
import type { AskQuestion } from '../../shared/approvals.ts'

// 折りたたむかは描画前の生の長さで見る（コードブロック1つで8行を超えても折りたたむ。今まで通り）
const isLong = (text: string) => text.length > 600 || text.split('\n').length > 8

interface Props {
  ts: string
  text: string
  markdown: boolean
  /** 待ちの行（許可待ち・質問待ち）。⏳ を付けて Markdown にせず出す */
  waiting?: boolean
  /** 待ちの行が答えを待っている質問の中身（#333。端末で開いた Claude の transcript から）。読むだけで下に並べる */
  questions?: AskQuestion[] | null
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
  /**
   * 検索から飛んできた当たり（#230）。`Chat` がこの印で場所を探して、そこまでスクロールして光らせる。
   * 行ごとに DOM の目印を置くのはここだけなので、3 つの分岐すべてに同じものを付ける
   */
  found?: boolean
  /**
   * バブル 1 つの識別子（`Utterance.key`）。フィードの返信先から飛ぶときに `Chat` がこれで探す（#297）。
   * `ts` はフィードでは同じ秒の別のセッションや、同じ行の自分の入力と重なるので、それとは別に持つ
   */
  utteranceKey?: string
  /** 差分を開くボタン（#280。フィードで、いまのブランチの PR に触れているバブルだけ）。無ければ出さない */
  diff?: DiffButtonProps
}

/** バブル1つ分の本文。長ければ折りたたんで「もっと見る」を付ける */
export function Message({ ts, text: raw, markdown, waiting, questions, resolved, thinking, thinkingOpen = false, summary, model, remote, linear, found = false, utteranceKey, diff }: Props) {
  // 自分の入力に添えた画像は、パスの文字列ではなくサムネイルで出す（本文の末尾に足してある。shared/attachments.ts）
  const { body: text, urls } = markdown ? { body: raw, urls: [] as string[] } : splitAttachments(raw)
  const [open, setOpen] = useState(false)
  // 一言があるとき、元の本文（詳細）を開いているか
  const [details, setDetails] = useState(false)
  const long = isLong(text)
  // 開いたら中身が見えるところまでスクロールする（#119）。詳細は .details、「もっと見る」は本文そのもの
  const [detailsRef, summaryRef] = useReveal<HTMLDivElement, HTMLDivElement>(details)
  const [bodyRef, moreRef] = useReveal<HTMLDivElement, HTMLButtonElement>(open)
  // 飛ぶための目印。`Chat` が data-ts（検索。#230）と data-key（フィードの返信先。#297）で引くので、どの分岐でも同じものを付ける
  const anchor = { 'data-ts': ts, ...(utteranceKey ? { 'data-key': utteranceKey } : {}) }
  const mark = found ? ' found' : ''
  if (waiting) {
    return (
      <div className={`msg waiting${resolved ? ' resolved' : ''}${mark}`} {...anchor}>
        <span className="time">{hm(ts)}</span>
        <div className="body" title={resolved ? 'この待ちはもう解消している' : '人の答えを待って止まっている'}>⏳ {text || '人を待って止まっている'}</div>
        {questions && !resolved && <QuestionPreview questions={questions} />}
      </div>
    )
  }
  if (summary && text) {
    // 一言 + 「詳細」。詳細を開いたら元の本文を今までどおり（Markdown、長ければ折りたたみ）
    return (
      <div className={`msg${mark}`} {...anchor}>
        <span className="time">{hm(ts)}</span>
        {thinking && <ThinkingBlock text={thinking} openAll={thinkingOpen} />}
        <div className="summary" ref={summaryRef}>
          {/* 一言の中の URL・#123・PGR-123 はリンクにする（shared/refs.ts）。HTML 文字列は作らない */}
          {/* source に元の本文を渡すと、そこに無い番号はリンクにならない（#268。一言は LLM が書くので、
              本文に無い番号を書くことがある。押すと無関係の issue に飛ぶ） */}
          {/* 一言の中の画像は名前だけ（LLM が本文から写したもの）。画像そのものは下に元の本文から並べる（#321） */}
          <span className="line"><ImageSourceContext value={null}><Inlines nodes={linkifyRefs(summary, { remote, linear, source: text })} /></ImageSourceContext></span>
          <button type="button" className="linkish details-toggle" onClick={() => setDetails((v) => !v)} aria-expanded={details}>
            {details ? '詳細を閉じる' : '詳細'}
          </button>
        </div>
        {/* 詳細を開いたら本文の中に出るので、ここでは二重に出さない */}
        {!details && <SourceImages text={text} />}
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
        {diff && <div className="msg-diff"><DiffButton {...diff} /></div>}
      </div>
    )
  }
  return (
    <div className={`msg${mark}`} {...anchor}>
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
      {diff && <div className="msg-diff"><DiffButton {...diff} /></div>}
    </div>
  )
}
