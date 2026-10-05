// 画面から答えた許可・質問（#693）を 1 行にする。DOM に触らない純粋関数（answeredLabels.test.ts）
import type { AnsweredApproval } from '../../shared/types.ts'

/** 待ちの 1 行の頭（`許可待ち: ` / `Codex の許可待ち: ` / `質問: ` など）。外して中身だけ出す */
const WAITING_HEAD = /^(?:[A-Za-z ]+の)?\s*(許可待ち|質問)\s*[:：]\s*/

export interface AnsweredLine {
  /** `許可した` / `拒否した` / `答えた` */
  verb: string
  /** 何に答えたか（待ちの 1 行から頭を外したもの） */
  what: string
  /** 押した選択肢の文言。無ければ空 */
  label: string
  tone: 'allow' | 'deny'
}

/** 「許可した: git add -A」の形にする。質問は「答えた」（拒否は質問でも「拒否した」） */
export function answeredLine(a: AnsweredApproval): AnsweredLine {
  const head = WAITING_HEAD.exec(a.text)
  const question = head?.[1] === '質問'
  const what = (head ? a.text.slice(head[0].length) : a.text).trim()
  const verb = a.behavior === 'deny' ? '拒否した' : question ? '答えた' : '許可した'
  return { verb, what, label: a.label ?? '', tone: a.behavior }
}
