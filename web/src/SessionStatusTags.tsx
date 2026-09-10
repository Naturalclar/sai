import { Fragment } from 'react'
import type { ReactNode } from 'react'
import type { HeadTag } from './headTags'
import { HostTag } from './HostTag'
import { SynthTag } from './SynthTag'
import { TerminalTag } from './TerminalTag'
import { WaitingTag } from './WaitingTag'
import { ReplyingTag } from './ReplyingTag'
import { ArchivedTag } from './ArchivedTag'
import { PermissionModeTag } from './PermissionModeTag'

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
    case 'archived':
      return <ArchivedTag />
    case 'mode':
      return <PermissionModeTag mode={tag.mode} />
  }
}

/**
 * チャット見出しの「いまの状態」の印の列（別のマシン・合成・端末・待機中・返信中・アーカイブ・許可モード）。
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
