// サイドバーの PR の印（#548）の色と説明。DOM に触らないので sessionPrState.test.ts を node:test で回す
import type { PrSummary } from '../../shared/types.ts'
import { checkLabel, isApproved, reviewLabel } from './prLabels.ts'

export type SessionPrState = 'draft' | 'failing' | 'approved' | 'open'

/**
 * 色は 1 つだけ選ぶ。**下書き → チェックが落ちている → 承認済み → それ以外** の順（人が次に手を出すべきものを先に）。
 * title には題名と、分かるぶんの状態（下書き・チェック・レビュー）を全部並べる
 */
export function sessionPrTag(pr: PrSummary): { state: SessionPrState; approved: boolean; title: string } {
  const approved = isApproved(pr.review_decision)
  const state: SessionPrState = pr.draft ? 'draft' : pr.checks === 'failure' ? 'failing' : approved ? 'approved' : 'open'
  const notes = [pr.draft ? '下書き' : '', checkLabel(pr.checks)?.title ?? '', reviewLabel(pr.review_decision)].filter(Boolean)
  // `approved` はチェックの印（#636）。色は 1 つだが、印は承認されていれば下書き・チェック落ちでも付く（4 か所で同じ規則）
  return { state, approved, title: `PR #${pr.number} ${pr.title}${notes.length ? `（${notes.join('・')}）` : ''}` }
}
