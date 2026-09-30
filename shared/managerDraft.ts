// Manager が入力欄に置いた「案」（#565）を出すかどうか。サーバ（一覧・詳細に載せる）とテストが使う純粋関数
import type { ManagerDraft, SessionSummary } from './types.ts'

/** 置いてから出しておく長さ。過ぎたら出さない（ファイルからは次に置いたときに捨てる） */
export const MANAGER_DRAFT_TTL_MS = 24 * 60 * 60 * 1000

/**
 * 置いたあとに人の入力が来たか。**時刻ではなく、置いたときの入力（`base_text`）と比べる**（#586 のレビュー）。
 * `last_user_ts` はターン完了の行からも付き、その行の `user_text` は**そのターンを始めた入力**なので、
 * 処理中に置いた案がそのターンの終わりで消えてしまう。
 * 置いたときにターンが回っていたら（`busy`）、そのターンが 1 つ終わっただけのときも入力とは数えない
 * （Codex は入力の行を書かないので、回っていたターンの入力はターン完了の行で初めて届く）
 */
export function inputSinceDraft(draft: ManagerDraft, s: Pick<SessionSummary, 'last_user_text' | 'turns' | 'last_kind'>): boolean {
  if ((s.last_user_text ?? '') === draft.base_text) return false
  if (draft.busy && s.turns === draft.base_turns + 1 && s.last_kind === 'turn') return false
  return true
}

/**
 * いま出してよい案か。**置いてから 24 時間以内**で、**置いたあとに人の入力が来ていない**（`inputSinceDraft()`）ときだけ。
 * 案を置いた後に人が何か送ったら、その案は前の文脈のものなので畳む
 */
export function liveManagerDraft(draft: ManagerDraft | undefined, s: Pick<SessionSummary, 'last_user_text' | 'turns' | 'last_kind'>, now: number): ManagerDraft | undefined {
  if (!draft || !draft.text.trim()) return undefined
  if (now - draft.at >= MANAGER_DRAFT_TTL_MS) return undefined
  if (inputSinceDraft(draft, s)) return undefined
  return draft
}
