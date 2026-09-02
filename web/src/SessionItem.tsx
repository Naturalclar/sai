import type { Replying, SessionSummary } from './api'
import { hm, md } from './format'
import { SynthTag } from './SynthTag'
import { ReplyingTag } from './ReplyingTag'
import { More } from './More'
import { stripMarkdown } from '../../shared/markdown.ts'

interface Props {
  s: SessionSummary
  active: boolean
  /** 画面から送った返信を処理中なら、その中身。「返信中」を付ける */
  replying: Replying | null
  /** 経過の基準（ポーリングの updatedAt） */
  now: number
}

/** サイドバーの一覧の1行 */
export function SessionItem({ s, active, replying, now }: Props) {
  return (
    <a className={`item${active ? ' active' : ''}`} href={`#/s/${encodeURIComponent(s.id)}`} title={s.id}>
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
        {replying && <ReplyingTag since={replying.since} now={now} />}
      </span>
      {s.turns > 1 && s.last_text && <span className="last">{stripMarkdown(s.last_text)}</span>}
    </a>
  )
}
