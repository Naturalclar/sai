// Manager が入力欄に置いた「案」（#565）を出すかどうか。サーバ（一覧・詳細に載せる）とテストが使う純粋関数
import type { ManagerDraft } from './types.ts'

/** 置いてから出しておく長さ。過ぎたら出さない（ファイルからは次に置いたときに捨てる） */
export const MANAGER_DRAFT_TTL_MS = 24 * 60 * 60 * 1000

/**
 * いま出してよい案か。**置いてから 24 時間以内**で、**置いたあとに人の入力が来ていない**ときだけ
 * （`lastUserTs` は `SessionSummary.last_user_ts`。画面から送っても端末で打っても載る。
 * 案を置いた後に人が何か送ったら、その案は前の文脈のものなので畳む）
 */
export function liveManagerDraft(draft: ManagerDraft | undefined, lastUserTs: string | undefined, now: number): ManagerDraft | undefined {
  if (!draft || !draft.text.trim()) return undefined
  if (now - draft.at >= MANAGER_DRAFT_TTL_MS) return undefined
  const input = lastUserTs ? Date.parse(lastUserTs) : NaN
  if (Number.isFinite(input) && input > draft.at) return undefined
  return draft
}
