// 端末で開いた Claude のセッションの質問（#333）を、どの待ちのバブルに出すか。DOM に依存しないので terminalQuestion.test.ts を node:test で回す
import { askQuestions, type AskQuestion } from '../../shared/approvals.ts'
import type { PendingQuestion } from '../../shared/types.ts'

/**
 * 待ちのバブルに添える質問。**まだ解消していない、同じ文の待ちのバブルだけ**に出す
 * （前に聞いた同じ文の質問や、解消した待ちには出さない。サーバも行の待ちと同じ文のときだけ `question` を載せる）。
 * 質問の形が読めなければ null（今までどおり文だけ）
 */
export function questionsFor(u: { waiting?: boolean; resolved?: boolean; text: string }, pending: PendingQuestion | undefined): AskQuestion[] | null {
  if (!pending || !u.waiting || u.resolved || u.text !== pending.text) return null
  const questions = askQuestions(pending.input)
  return questions.length > 0 ? questions : null
}
