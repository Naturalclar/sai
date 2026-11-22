import { useEffect, useRef, useState } from 'react'
import { answersReady, joinAnswer, questionKey, type AskQuestion } from '../../shared/approvals.ts'
import { approvalAction, askEnterAction, hotkeyAppliesAt, keyBlocked, optionIndex } from './approvalKeys'
import { isTypingTarget } from './sessionNav'

interface Props {
  questions: AskQuestion[]
  /**
   * キーで答えてよいか（#909）。フォーカスのあるペインの一番上の答え待ちで、答えられる質問のときだけ true（決めるのは ApprovalBubble）。
   * `1`〜`9` で選択肢（入力欄の外だけ）、`⌘Enter` で次へ・送る
   */
  hotkey?: boolean
  /** この質問のエンティティ（別のセッションの返信欄で押されたキーを受けないため） */
  entity?: string
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

const NO_QUESTION: AskQuestion = { question: '', header: '', options: [], multiSelect: false, other: false, secret: false }

const answerOf = (p: Pick) => joinAnswer(p.labels, p.otherOn ? p.other : '')

/**
 * AskUserQuestion の質問に **1問ずつ** 答える（#195）。1回で最大4問聞かれるので、全部積むと携帯で読めない。
 * 選択肢のほかに「その他」の自由記入があり（端末の同じダイアログと同じ。label 以外の文字列も CLI はそのまま受け取る）、
 * 推奨の印が付いた選択肢にはバッジを出す。答えは最後の1問まで溜めて1回で送る（欠けると CLI が「答えが無い」扱いにする）
 */
export function AskQuestions({ questions, hotkey = false, entity = '', busy, done, onAnswer, onDecline }: Props) {
  const [step, setStep] = useState(0)
  const [picks, setPicks] = useState<Record<string, Pick>>({})
  // 「その他」を開いたら記入欄へ当てる（押したとき・キーで選んだときだけ。「戻る」で記入欄が描き直されたときは当てない）
  const otherRef = useRef<HTMLInputElement>(null)
  // このバブルの外枠。「その他」の記入欄の ⌘Enter・数字を、ほかの質問のバブルのものと取り違えないため
  const rootRef = useRef<HTMLDivElement>(null)

  // 問いが無いときは何も描かない（下の return の手前）。フックを早い return より前に置くため、ここでは空の問いで埋める
  const q = questions[Math.min(step, questions.length - 1)] ?? NO_QUESTION
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
  const toggleOther = () => {
    update(q.multiSelect ? { ...pick, otherOn: !pick.otherOn } : { labels: [], otherOn: !pick.otherOn, other: pick.other })
    if (!pick.otherOn) requestAnimationFrame(() => otherRef.current?.focus())
  }

  // キーで答える（#909）。数字は入力欄の外だけ（入力欄の数字は文字のまま）。単一選択は選んで次の問いへ、いくつでも選べる問いは
  // 付け外しだけ（進むのは ⌘Enter）。最後の数字（「その他」があるとき）は記入欄を開く。⌘Enter は全部そろうまで送らない。
  // 許可の ⌘Enter と同じく capture で先に取り、拾ったときだけ止める。描くたびに張り直す（いまの問い・選びかけを閉じ込めるため）
  useEffect(() => {
    if (!hotkey || frozen || q === NO_QUESTION) return
    const onKeyDown = (e: KeyboardEvent) => {
      const target = e.target instanceof Element ? e.target : null
      const typing = isTypingTarget(target as HTMLElement | null)
      const inside = target !== null && rootRef.current?.contains(target) === true
      // 数字を受けるのは、どこにもフォーカスが無い・サイドバー（Esc で外したあと）・このバブルの中だけ。
      // ほかの行のボタンやメニューにフォーカスがあるときの数字は、裏の質問に使わない
      const digitPlace = target === null || target === document.body || inside || target.closest('.channels') !== null
      const index = optionIndex(e, q.options.length + (q.other ? 1 : 0), typing || !digitPlace)
      // 質問の外の入力欄（返信欄・ほかの質問の記入欄）の ⌘Enter は取らない。このバブルの「その他」の記入欄の中なら取る
      const typingElsewhere = typing && !inside
      const enter = index === null && !e.repeat && approvalAction(e, false) !== null ? askEnterAction(last, !!answers[key]!.trim(), answersReady(questions, answers), typingElsewhere) : null
      if (index === null && enter === null) return
      const root = rootRef.current
      const blocked = keyBlocked({
        modalOpen: document.querySelector('.modal-backdrop') !== null,
        // display:none の祖先（隠れたペイン）の中なら offsetParent が null
        hidden: root === null || root.offsetParent === null,
        inOtherBubble: target !== null && target.closest('.group.approval') !== null && !root?.closest('.group.approval')?.contains(target),
      })
      if (!hotkeyAppliesAt(target, entity, blocked)) return
      e.preventDefault()
      e.stopPropagation()
      if (enter === 'next') setStep(step + 1)
      else if (enter === 'send') onAnswer(answers)
      else if (index !== null && index >= q.options.length) toggleOther()
      else if (index !== null && q.multiSelect) toggle(q.options[index]!.label)
      else if (index !== null) {
        update({ labels: [q.options[index]!.label], otherOn: false, other: pick.other })
        if (!last) setStep(step + 1)
      }
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  })

  if (q === NO_QUESTION) return null
  return (
    <div className="questions" ref={rootRef}>
      <div className="question">
        <div className="q">
          {questions.length > 1 && <span className="step">{step + 1} / {questions.length}</span>}
          {q.header && <b>{q.header}: </b>}
          {q.question}
          {q.multiSelect && <span className="multi">いくつでも</span>}
        </div>
        <div className="options">
          {q.options.map((o, i) => (
            <button
              type="button"
              key={o.label}
              className={pick.labels.includes(o.label) ? 'picked' : ''}
              disabled={frozen}
              onClick={() => toggle(o.label)}
            >
              <span className="label">
                {hotkey && !frozen && i < 9 && <kbd className="num">{i + 1}</kbd>}
                {o.label}
                {o.recommended && <span className="rec">推奨</span>}
              </span>
              {o.description && <span className="desc">{o.description}</span>}
            </button>
          ))}
          {q.other && (
            <button type="button" className={pick.otherOn ? 'picked' : ''} disabled={frozen} onClick={toggleOther}>
              <span className="label">
                {hotkey && !frozen && q.options.length < 9 && <kbd className="num">{q.options.length + 1}</kbd>}
                その他
              </span>
              <span className="desc">選択肢に無い答えを書く</span>
            </button>
          )}
        </div>
        {pick.otherOn && (
          <input
            type={q.secret ? 'password' : 'text'}
            className="other"
            placeholder="答えをそのまま書く（エージェントにこの文字列が届く）"
            ref={otherRef}
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
