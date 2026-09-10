// チャット見出しの「いまの状態」の印と、狭い画面の 1 行目に出す名前（#274）。
// 広い画面の見出し・狭い画面の 1 行目・「⋯」のパネルが同じものを使うので、出すかどうかの判定はここに 1 つだけ置く
import { isRemoteHost } from '../../shared/host.ts'
import { projectName } from '../../shared/project.ts'
import type { SessionSummary, Terminal } from '../../shared/types.ts'

/** 印 1 つ分。並びはこの順で出す */
export type HeadTag =
  | { kind: 'host'; host: string }
  | { kind: 'synth' }
  | { kind: 'source'; source: string }
  | { kind: 'terminal'; terminal: Terminal }
  | { kind: 'waiting'; text: string }
  | { kind: 'approval'; text: string }
  | { kind: 'replying'; since: string }
  | { kind: 'archived' }
  | { kind: 'mode'; mode: string }

export type HeadTagSession = Pick<SessionSummary, 'host' | 'session_source' | 'terminal' | 'waiting' | 'archived' | 'permission_mode'>

export interface HeadTagInput {
  /** サーバのマシン名（応答の host）。行の host と違えば別のマシンの印 */
  serverHost: string
  /** 答え待ちの先頭の文言。無ければ空 */
  approval: string
  /** 画面から送った返信の送った時刻。処理中でなければ空 */
  replyingSince: string
  /**
   * 狭い画面の 1 行目か。**素の出どころ（`payload` / `rollout`）だけを落とす**（見るのはたまにで、1 行目の幅を食う）。
   * 合成（synth）は返信できない理由なので落とさない。許可モードも落とさない（素通しを選んだまま忘れるのが一番まずい。#253）
   */
  compact: boolean
}

export function headTags(s: HeadTagSession, input: HeadTagInput): HeadTag[] {
  const tags: HeadTag[] = []
  if (isRemoteHost(s.host, input.serverHost)) tags.push({ kind: 'host', host: s.host })
  if (s.session_source === 'synth') tags.push({ kind: 'synth' })
  else if (s.session_source && !input.compact) tags.push({ kind: 'source', source: s.session_source })
  if (s.terminal) tags.push({ kind: 'terminal', terminal: s.terminal })
  if (s.waiting) tags.push({ kind: 'waiting', text: s.waiting })
  if (input.approval) tags.push({ kind: 'approval', text: input.approval })
  if (input.replyingSince) tags.push({ kind: 'replying', since: input.replyingSince })
  if (s.archived) tags.push({ kind: 'archived' })
  // 通常のモードは印を出さない（普段と違うときだけ目立たせる）
  if (s.permission_mode && s.permission_mode !== 'default') tags.push({ kind: 'mode', mode: s.permission_mode })
  return tags
}

/**
 * 狭い画面の 1 行目の名前。表示名があればそれを主にして `#project` を添え、無ければ `#project` だけ。
 * project は bare clone の worktree でも崩れないリポジトリ名で、分からなければ repo（広い画面の `<h1>` と同じ）
 */
export function headName(s: Pick<SessionSummary, 'project' | 'repo' | 'meta'>): { name: string; project: string } {
  return { name: s.meta?.name ?? '', project: projectName(s.project) || s.repo }
}
