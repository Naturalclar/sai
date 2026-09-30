// 端末で開いた Claude のセッションの質問（#333）を、どの待ちのバブルに出すか。DOM に依存しないので terminalQuestion.test.ts を node:test で回す
import { askQuestions, type AskQuestion } from '../../shared/approvals.ts'
import type { FeedRow, PendingQuestion } from '../../shared/types.ts'

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

/**
 * 待ちのバブルに添える質問を、**行そのもの**から（#334。record.py が v9 から `questions` を載せる）。
 * transcript を読む #333 と違って、別のマシンのセッションでもフィードでも出せる。まだ解消していない待ちのバブルだけ。
 * 行に無ければ null（呼ぶ側が #333 の `questionsFor()` に落とす）
 */
export function rowQuestions(u: { waiting?: boolean; resolved?: boolean; row: Pick<FeedRow, 'questions'> }): AskQuestion[] | null {
  if (!u.waiting || u.resolved || !Array.isArray(u.row.questions) || u.row.questions.length === 0) return null
  const questions = askQuestions({ questions: u.row.questions })
  return questions.length > 0 ? questions : null
}
