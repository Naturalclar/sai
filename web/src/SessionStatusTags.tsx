import { Fragment } from 'react'
import type { ReactNode } from 'react'
import type { HeadTag } from './headTags'
import { HostTag } from './HostTag'
import { SynthTag } from './SynthTag'
import { TerminalTag } from './TerminalTag'
import { WaitingTag } from './WaitingTag'
import { ReplyingTag } from './ReplyingTag'
import { ArchivedTag } from './ArchivedTag'
import { StopMissingTag } from './StopMissingTag'
import { ReturnedTag } from './ReturnedTag'
import { PermissionModeTag } from './PermissionModeTag'
import { ContextTag } from './ContextTag'

/** 印 1 つ分の見た目。出すかどうかと並びは headTags() が決める */
function tagOf(tag: HeadTag, now: number): ReactNode {
  switch (tag.kind) {
    case 'host':
      return <HostTag host={tag.host} />
    case 'synth':
      return <SynthTag />
    case 'source':
      return <span className="tag">{tag.source}</span>
    case 'terminal':
      return <TerminalTag terminal={tag.terminal} />
    case 'waiting':
    case 'approval':
      return <WaitingTag text={tag.text} />
    case 'replying':
      return <ReplyingTag since={tag.since} now={now} />
    case 'stop_missing':
      return <StopMissingTag />
    case 'archived':
      return <ArchivedTag />
    case 'returned':
      return <ReturnedTag at={tag.at} />
    case 'mode':
      return <PermissionModeTag mode={tag.mode} />
    case 'context':
      return <ContextTag tokens={tag.tokens} />
  }
}

/**
 * チャット見出しの「いまの状態」の印の列（別のマシン・合成・端末・待機中・返信中・アーカイブ・アーカイブ後も継続・許可モード・大きすぎるコンテキスト）。
 * 広い画面の見出しと、狭い画面の 1 行目（#274）が使う。title はセッション ID（マウスを乗せると出る）
 */
export function SessionStatusTags({ tags, now, title }: { tags: HeadTag[]; now: number; title: string }) {
  if (tags.length === 0) return null
  return (
    <span className="meta head-tags" title={title}>
      {tags.map((t) => (
        <Fragment key={t.kind}>{tagOf(t, now)}</Fragment>
      ))}
    </span>
  )
}
