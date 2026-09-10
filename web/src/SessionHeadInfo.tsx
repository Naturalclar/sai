import type { SessionSummary } from './api'
import { dayLabel, hm } from './format'
import { AgentChip } from './AgentChip'
import { RepoLink } from './RepoLink'
import { ModelTag } from './ModelTag'

/**
 * チャット見出しの「詳しい情報」（エージェント・リポジトリへのリンク・使ったモデル・ブランチ・期間とターン数）。
 * 広い画面では見出しにそのまま並び、狭い画面では「⋯」のパネルの中に入る（#274）
 */
export function SessionHeadInfo({ s }: { s: SessionSummary }) {
  return (
    <>
      <span className="meta"><AgentChip agent={s.agent} /></span>
      {/* origin が分かるときだけ、そのリポジトリへのリンク（remote が無ければ何も出ない） */}
      <RepoLink project={s.project} remote={s.remote} />
      {/* 使ったモデルの表示だけ。返信で使うモデルを変えるのは入力欄（送信ボタンの左） */}
      {s.model && <span className="meta"><ModelTag model={s.model} models={s.models} /></span>}
      {s.branch && <span className="meta"><code>{s.branch}</code></span>}
      <span className="meta">{dayLabel(s.start)} {hm(s.start)} – {hm(s.end)} · {s.turns} ターン</span>
    </>
  )
}
