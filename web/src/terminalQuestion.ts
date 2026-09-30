// 端末で開いた Claude のセッションの質問（#333）を、どの待ちのバブルに出すか。DOM に依存しないので terminalQuestion.test.ts を node:test で回す
import { askQuestions, type AskQuestion } from '../../shared/approvals.ts'
import type { ApprovalMap, FeedRow, PendingQuestion, ReplyingMap } from '../../shared/types.ts'

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
 * さらに #333 の `pendingQuestion()`（server/app.ts）と同じ 2 つを見る（#518 のレビュー）:
 * - **いまのセッションの待ちがその文のまま**（`live.waiting`。端末で人が答えると、ターン完了の行を待たずに
 *   `WaitingSettle` が畳む。行の `resolved` は次の行が来るまで立たないので、これを見ないと答えたあとも選択肢が残る）
 * - **SAI の画面で答えられる質問ではない**（`answerable`。`claude -p` の質問は `approvals` の答えられるバブルが出るので、
 *   読むだけの写しを並べると同じ質問が 2 つ出る）
 * 行に無ければ null（呼ぶ側が #333 の `questionsFor()` に落とす）
 */
export function rowQuestions(
  u: { waiting?: boolean; resolved?: boolean; text: string; row: Pick<FeedRow, 'questions'> },
  live: { waiting: string } | undefined,
  answerable: boolean,
): AskQuestion[] | null {
  if (!u.waiting || u.resolved || answerable || !live || live.waiting !== u.text) return null
  if (!Array.isArray(u.row.questions) || u.row.questions.length === 0) return null
  const questions = askQuestions({ questions: u.row.questions })
  return questions.length > 0 ? questions : null
}

/**
 * SAI の画面で質問に答えられるセッション（答えられる承認が出ている、か SAI が別プロセスで回している＝`-p` の質問は
 * 必ず `--permission-prompt-tool` を通って承認として出る）。`todoItems.ts` の `processReplying()` と同じ見方
 */
export function answerableIds(approvals: ApprovalMap, replying: ReplyingMap): Set<string> {
  const ids = new Set<string>()
  for (const [id, list] of Object.entries(approvals)) if (list.some((a) => a.answerable !== false)) ids.add(id)
  for (const [id, r] of Object.entries(replying)) if (r.via !== 'terminal' && !r.failed) ids.add(id)
  return ids
}
