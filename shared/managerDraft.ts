// Manager が入力欄に置いた「案」（#565）を出すかどうか。サーバ（一覧・詳細に載せる）とテストが使う純粋関数
import { eventKind } from './events.ts'
import type { Agent, FeedRow, ManagerDraft } from './types.ts'
import { rowMs } from './unread.ts'

/** 置いてから出しておく長さ。過ぎたら出さない（ファイルからは次に置いたときに捨てる） */
export const MANAGER_DRAFT_TTL_MS = 24 * 60 * 60 * 1000

/**
 * 置いたあとに人の入力が来たか。**そのセッションの、置いた時刻より後の行**で決める（#586 のレビュー）:
 * - 入力の行（`resume` で `user_text` のあるもの。Claude の `UserPromptSubmit`）が 1 本でも来たら、来た
 * - 入力の行を書かないエージェント（Codex / OpenCode）だけ、ターン完了の行も数える。置いたときにターンが回っていなければ 1 本、
 *   回っていたら（`busy`）2 本目で来たとみなす（回っていたターンの終わりは人の入力ではない）
 * - 入力の行を書く Claude / Grok ではターン完了の行を数えない（バックグラウンドのタスクが終わって自分で起きたターンは、
 *   入力の行無しにターン完了の行だけが来ることがある。#586 のレビュー）
 *
 * `last_user_ts` と比べるのはやめた（ターン完了の行でも進むので、処理中に置いた案がそのターンの終わりで消えた）。
 * `last_user_text` や `turns` と比べるのもやめた（1 行目が同じ入力を見逃す・`turns` は窓で数えが変わる）
 */
export function inputSinceDraft(draft: ManagerDraft, rows: readonly FeedRow[], agent: Agent): boolean {
  const countsTurns = agent !== 'claude' && agent !== 'grok'
  let turns = 0
  for (const r of rows) {
    if (!(rowMs(r.ts) > draft.at)) continue
    const kind = eventKind(r.event, r.text)
    if (kind === 'resume' && r.user_text?.trim()) return true
    if (kind === 'turn') turns++
  }
  return countsTurns && turns > (draft.busy ? 1 : 0)
}

/**
 * いま出してよい案か。**置いてから 24 時間以内**で、**置いたあとに人の入力が来ていない**（`inputSinceDraft()`）ときだけ。
 * `rows` はそのセッションの行（置いてから後の分が入っていればよい）。案を置いた後に人が何か送ったら、その案は前の文脈のものなので畳む
 */
export function liveManagerDraft(draft: ManagerDraft | undefined, rows: readonly FeedRow[], agent: Agent, now: number): ManagerDraft | undefined {
  if (!draft || !draft.text.trim()) return undefined
  if (now - draft.at >= MANAGER_DRAFT_TTL_MS) return undefined
  if (inputSinceDraft(draft, rows, agent)) return undefined
  return draft
}
