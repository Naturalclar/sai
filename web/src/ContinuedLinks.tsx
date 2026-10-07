import type { SessionMeta } from './api'
import { sessionHash } from './hooks'

/** 引き継ぎの前後へのリンク（#442）。新しい方に「← 前のセッション」、前の方に「→ 続き」。分岐したセッション（#405）には「← 分岐元」 */
export function ContinuedLinks({ meta }: { meta: SessionMeta | undefined }) {
  if (!meta?.continued_from && !meta?.continued_to && !meta?.forked_from) return null
  return (
    <span className="meta continued">
      {meta.forked_from && <a href={sessionHash(meta.forked_from)} title={`分岐元: ${meta.forked_from}`}>← 分岐元</a>}
      {meta.continued_from && <a href={sessionHash(meta.continued_from)} title={`引き継ぎ元: ${meta.continued_from}`}>← 前のセッション</a>}
      {meta.continued_to && <a href={sessionHash(meta.continued_to)} title={`引き継いだ先: ${meta.continued_to}`}>→ 続き</a>}
    </span>
  )
}
