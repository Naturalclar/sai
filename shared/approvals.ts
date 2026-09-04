// 返信中の許可・質問（Approval）の読み書き。サーバ（server/approvals.ts）が text を作り、
// 画面（web/src/ApprovalBubble.tsx）が AskUserQuestion の選択肢を出して answers を組み立てる。
// 文言は feed/record.py の待ちの行（tool_summary / waiting_text）と揃えてある
import type { Approval, ApprovalAnswer } from './types.ts'

export const APPROVAL_TEXT_MAX = 300

const clip = (text: string, size: number) => {
  const chars = Array.from(text)
  return chars.length <= size ? text : chars.slice(0, size).join('')
}

const firstLines = (text: string, n: number) =>
  text
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(0, n)
    .join('\n')

/** AskUserQuestion の入力から質問を取り出す。形が違えば空 */
export interface AskQuestion {
  question: string
  header: string
  options: { label: string; description: string }[]
  multiSelect: boolean
}

export function askQuestions(input: Record<string, unknown>): AskQuestion[] {
  const raw = input.questions
  if (!Array.isArray(raw)) return []
  const out: AskQuestion[] = []
  for (const q of raw) {
    if (!q || typeof q !== 'object') continue
    const o = q as Record<string, unknown>
    if (typeof o.question !== 'string' || !o.question.trim()) continue
    const options = Array.isArray(o.options)
      ? o.options
          .filter((x): x is Record<string, unknown> => !!x && typeof x === 'object' && typeof (x as Record<string, unknown>).label === 'string')
          .map((x) => ({ label: String(x.label), description: typeof x.description === 'string' ? x.description : '' }))
      : []
    out.push({ question: o.question, header: typeof o.header === 'string' ? o.header : '', options, multiSelect: o.multiSelect === true })
  }
  return out
}

/** 許可ダイアログに出るのと同じ「何をしようとしているか」。300文字で切る */
export function toolSummary(toolName: string, input: Record<string, unknown>): string {
  // この 2 つは中身が無ければ空（JSON をそのまま出しても読めない）
  if (toolName === 'AskUserQuestion') {
    const qs = askQuestions(input).map((q) => q.question.trim()).filter(Boolean)
    return qs.length ? clip(qs.join(' / '), APPROVAL_TEXT_MAX) : ''
  }
  if (toolName === 'ExitPlanMode') {
    const plan = input.plan
    return typeof plan === 'string' && plan.trim() ? clip(firstLines(plan, 3), APPROVAL_TEXT_MAX) : ''
  }
  for (const key of ['command', 'file_path', 'notebook_path', 'url', 'description', 'prompt', 'pattern', 'query']) {
    const v = input[key]
    if (typeof v === 'string' && v.trim()) return clip(v.trim(), APPROVAL_TEXT_MAX)
  }
  try {
    return clip(JSON.stringify(input), APPROVAL_TEXT_MAX)
  } catch {
    return ''
  }
}

/** 画面に出す1行。record.py の waiting_text() と同じ接頭辞 */
export function approvalText(toolName: string, input: Record<string, unknown>): string {
  const summary = toolSummary(toolName, input)
  if (toolName === 'AskUserQuestion') return summary ? `質問: ${summary}` : '質問に答えるのを待っている'
  if (toolName === 'ExitPlanMode') return summary ? `プランの承認待ち: ${summary}` : 'プランの承認待ち'
  return summary ? `許可待ち: ${toolName}: ${summary}` : `許可待ち: ${toolName}`
}

/**
 * AskUserQuestion の答え。CLI は `updatedInput.answers`（質問文 → 選んだ label。複数選択はカンマ区切り）を読む。
 * 元の questions をそのまま返さないと「答えが無い」扱いになる
 */
export function answerAsk(approval: Approval, answers: Record<string, string>): ApprovalAnswer {
  return { behavior: 'allow', updatedInput: { ...approval.input, answers } }
}
