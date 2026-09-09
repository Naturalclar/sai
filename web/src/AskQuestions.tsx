import { useState } from 'react'
import { answersReady, joinAnswer, questionKey, type AskQuestion } from '../../shared/approvals.ts'

interface Props {
  questions: AskQuestion[]
  /** 送信中 */
  busy: boolean
  /** もう答えた（ボタンを押せなくする） */
  done: boolean
  /** 全問そろったら呼ぶ。Codexはquestion id、Claudeは質問文 → 答え */
  onAnswer: (answers: Record<string, string>) => void
  onDecline: () => void
}

/** 1問ぶんの選びかけ。選んだ label と、選択肢に無い答え（その他の自由記入） */
interface Pick {
  labels: string[]
  /** 「その他」を開いているか。開いただけで空のうちは答えにならない */
  otherOn: boolean
  other: string
}

const EMPTY: Pick = { labels: [], otherOn: false, other: '' }

const answerOf = (p: Pick) => joinAnswer(p.labels, p.otherOn ? p.other : '')

/**
 * AskUserQuestion の質問に **1問ずつ** 答える（#195）。1回で最大4問聞かれるので、全部積むと携帯で読めない。
 * 選択肢のほかに「その他」の自由記入があり（端末の同じダイアログと同じ。label 以外の文字列も CLI はそのまま受け取る）、
 * 推奨の印が付いた選択肢にはバッジを出す。答えは最後の1問まで溜めて1回で送る（欠けると CLI が「答えが無い」扱いにする）
 */
export function AskQuestions({ questions, busy, done, onAnswer, onDecline }: Props) {
  const [step, setStep] = useState(0)
  const [picks, setPicks] = useState<Record<string, Pick>>({})

  const q = questions[Math.min(step, questions.length - 1)]
  if (!q) return null
  const key = questionKey(q)
  const pick = picks[key] ?? EMPTY
  const answers: Record<string, string> = {}
  for (const item of questions) {
    const itemKey = questionKey(item)
    answers[itemKey] = answerOf(picks[itemKey] ?? EMPTY)
  }
  const last = step >= questions.length - 1
  const frozen = busy || done

  const update = (next: Pick) => setPicks((all) => ({ ...all, [key]: next }))
  const toggle = (label: string) => {
    if (q.multiSelect) {
      const has = pick.labels.includes(label)
      update({ ...pick, labels: has ? pick.labels.filter((l) => l !== label) : [...pick.labels, label] })
    } else {
      // 単一選択では選択肢と自由記入は排他（両方入れると答えが2つになる）
      update({ labels: pick.labels[0] === label ? [] : [label], otherOn: false, other: pick.other })
    }
  }
  const toggleOther = () =>
    update(q.multiSelect ? { ...pick, otherOn: !pick.otherOn } : { labels: [], otherOn: !pick.otherOn, other: pick.other })

  return (
    <div className="questions">
      <div className="question">
        <div className="q">
          {questions.length > 1 && <span className="step">{step + 1} / {questions.length}</span>}
          {q.header && <b>{q.header}: </b>}
          {q.question}
          {q.multiSelect && <span className="multi">いくつでも</span>}
        </div>
        <div className="options">
          {q.options.map((o) => (
            <button
              type="button"
              key={o.label}
              className={pick.labels.includes(o.label) ? 'picked' : ''}
              disabled={frozen}
              onClick={() => toggle(o.label)}
            >
              <span className="label">
                {o.label}
                {o.recommended && <span className="rec">推奨</span>}
              </span>
              {o.description && <span className="desc">{o.description}</span>}
            </button>
          ))}
          {q.other && (
            <button type="button" className={pick.otherOn ? 'picked' : ''} disabled={frozen} onClick={toggleOther}>
              <span className="label">その他</span>
              <span className="desc">選択肢に無い答えを書く</span>
            </button>
          )}
        </div>
        {pick.otherOn && (
          <input
            type={q.secret ? 'password' : 'text'}
            className="other"
            placeholder="答えをそのまま書く（エージェントにこの文字列が届く）"
            value={pick.other}
            disabled={frozen}
            onChange={(e) => update({ ...pick, other: e.target.value })}
          />
        )}
      </div>
      <div className="actions">
        {step > 0 && (
          <button type="button" disabled={frozen} onClick={() => setStep(step - 1)}>
            戻る
          </button>
        )}
        {!last ? (
          <button type="button" className="allow" disabled={frozen || !answers[key]!.trim()} onClick={() => setStep(step + 1)}>
            次へ
          </button>
        ) : (
          <button type="button" className="allow" disabled={frozen || !answersReady(questions, answers)} onClick={() => onAnswer(answers)}>
            {done ? '答えた' : '答える'}
          </button>
        )}
        <button type="button" className="deny" disabled={frozen} onClick={onDecline}>
          答えない
        </button>
      </div>
    </div>
  )
}
