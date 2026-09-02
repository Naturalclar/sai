import { useEffect, useRef } from 'react'
import type { Replying, SessionSummary } from './api'
import { hm, md } from './format'
import { SynthTag } from './SynthTag'
import { ReplyingTag } from './ReplyingTag'
import { ArchivedTag } from './ArchivedTag'
import { WaitingTag } from './WaitingTag'
import { More } from './More'
import { SessionArchiveButton } from './SessionArchiveButton'
import { stripMarkdown } from '../../shared/markdown.ts'

interface Props {
  s: SessionSummary
  active: boolean
  /** 画面から送った返信を処理中なら、その中身。「返信中」を付ける */
  replying: Replying | null
  /** 経過の基準（ポーリングの updatedAt） */
  now: number
}

/**
 * サイドバーの一覧の1行。リンク（<a>）と、その上に重ねる「アーカイブ」ボタンは兄弟にする
 * （<a> の中に <button> は置けない。押してもページを動かさない）
 */
export function SessionItem({ s, active, replying, now }: Props) {
  // 選ばれたら見えるところまでサイドバーをスクロールする（キーボードで移動したとき用。見えていれば動かない）
  const ref = useRef<HTMLAnchorElement>(null)
  useEffect(() => {
    if (active) ref.current?.scrollIntoView({ block: 'nearest' })
  }, [active])
  return (
    <div className={`item${active ? ' active' : ''}${s.archived ? ' archived' : ''}`}>
      {/* 合成 ID は集計の切れ方で付け先がずれるのでアーカイブできない（#31 と同じ） */}
      {s.session_source !== 'synth' && <SessionArchiveButton key={`${s.id}:${s.archived ? 1 : 0}`} id={s.id} archived={Boolean(s.archived)} />}
    <a ref={ref} className="link" href={`#/s/${encodeURIComponent(s.id)}`} title={s.id}>
      <span className="top">
        <span className="repo">
          <span className={`dot ${s.agent}`} />
          {s.repo || '—'}<More n={s.repos.length} />
          {s.branch && <span className="br"> / {s.branch}<More n={s.branches.length} /></span>}
        </span>
        <span className="when"><b>{md(s.end)}</b> {hm(s.end)} · {s.turns}</span>
      </span>
      <span className="t" title={s.title_full}>
        {s.meta?.icon && <span className="icon">{s.meta.icon}</span>}
        {s.meta?.name || s.title || '(無題)'}
        {s.session_source === 'synth' && <SynthTag />}
        {s.waiting && <WaitingTag text={s.waiting} />}
        {replying && <ReplyingTag since={replying.since} now={now} />}
        {s.archived && <ArchivedTag />}
      </span>
      {s.turns > 1 && s.last_text && <span className="last">{stripMarkdown(s.last_text)}</span>}
    </a>
    </div>
  )
}
