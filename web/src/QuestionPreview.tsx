import type { AskQuestion } from '../../shared/approvals.ts'

interface Props {
  questions: AskQuestion[]
}

/**
 * 端末で開いた Claude のセッションの質問を、**読むだけ**で出す（#333）。答えるのは端末
 * （選択の画面にキーを送ると誤って選びうるので、SAI からは選ばない。Codex の TUI の質問と同じ。#208）。
 * 見た目は答えられる質問（`AskQuestions`）に揃えるが、押せないので 1 問ずつにはせず全部並べる
 */
export function QuestionPreview({ questions }: Props) {
  return (
    <div className="questions preview">
      {questions.map((q, i) => (
        <div className="question" key={`${i}:${q.question}`}>
          <div className="q">
            {q.header && <b>{q.header}: </b>}
            {q.question}
            {q.multiSelect && <span className="multi">いくつでも</span>}
          </div>
          <ol className="options">
            {q.options.map((o, j) => (
              <li key={`${j}:${o.label}`}>
                <span className="label">
                  {o.label}
                  {o.recommended && <span className="rec">推奨</span>}
                </span>
                {o.description && <span className="desc">{o.description}</span>}
              </li>
            ))}
          </ol>
        </div>
      ))}
      <div className="hint">端末で答えてください（SAI からは選べません）</div>
    </div>
  )
}
