import type { SessionSummary } from './api'
import { hm, md } from './format'
import { SynthTag } from './SynthTag'
import { More } from './More'
import { stripMarkdown } from '../../shared/markdown.ts'

/** サイドバーの一覧の1行 */
export function SessionItem({ s, active }: { s: SessionSummary; active: boolean }) {
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
      </span>
      {s.turns > 1 && s.last_text && <span className="last">{stripMarkdown(s.last_text)}</span>}
    </a>
  )
}
