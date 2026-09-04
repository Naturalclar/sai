// 返信中の許可・質問（Approval）の読み書き。サーバ（server/approvals.ts）が text を作り、
// 画面（web/src/ApprovalBubble.tsx）が AskUserQuestion の選択肢を出して answers を組み立てる。
// 文言は feed/record.py の待ちの行（tool_summary / waiting_text）と揃えてある
import type { Approval, ApprovalAnswer, PermissionRule } from './types.ts'

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

// ---- 「常に許可」のルール。CLI（2.1.259）は permission_suggestions を送ってこないので SAI が組み立てる。
// 形は Claude の許可ルールそのもの（`Bash(gh pr:*)`）。前方一致の実装は Claude 側に任せ、ここは接頭辞を選ぶだけ

/** サブコマンドを持つ CLI。`gh pr create` なら `gh pr` までを接頭辞にする（`gh` 全部を許すのは広すぎる） */
const SUBCOMMAND_CLIS = new Set([
  'gh', 'git', 'npm', 'pnpm', 'yarn', 'npx', 'bun', 'deno', 'node', 'python', 'python3', 'pip', 'pip3', 'uv', 'poetry',
  'docker', 'kubectl', 'cargo', 'go', 'make', 'brew', 'terraform', 'aws', 'gcloud', 'az', 'tailscale',
])

/** コマンドの先頭のひとまとまり。`&&` や `|` の手前まで。環境変数の代入（`FOO=1 cmd`）は飛ばす */
function commandTokens(command: string): string[] {
  const head = command.split(/\s*(?:&&|\|\||[|;]|\n)\s*/)[0] ?? ''
  return head.trim().split(/\s+/).filter(Boolean).filter((t, i, all) => !(i < all.length - 1 && /^[A-Za-z_][A-Za-z0-9_]*=/.test(t)))
}

/**
 * このツール呼び出しに対する「常に許可」のルール。無ければ null（そのツールには「常に」を出さない）。
 * - Bash: コマンドの先頭 1 語（サブコマンドを持つ CLI は 2 語）で前方一致 `Bash(gh pr:*)`
 * - MCP ツール（mcp__サーバ__名前）: そのツール名そのもの
 * - それ以外（Edit / Write / Read / WebFetch など）と AskUserQuestion / ExitPlanMode: 出さない
 *   （ファイル系の「全部許す」は端末でもセッション限定なので、設定に焼くのは広すぎる）
 */
export function alwaysAllowRule(toolName: string, input: Record<string, unknown>): PermissionRule | null {
  if (toolName === 'Bash') {
    const command = typeof input.command === 'string' ? input.command : ''
    const tokens = commandTokens(command)
    const first = tokens[0]
    if (!first || /[^\w./+-]/.test(first)) return null // 記号だけ・展開の入った先頭は当てにしない
    const second = tokens[1]
    // 2 語目がフラグ（-x / --long）や記号なら 1 語で止める
    const prefix = SUBCOMMAND_CLIS.has(first) && second && /^[\w.][\w.-]*$/.test(second) ? `${first} ${second}` : first
    return { toolName: 'Bash', ruleContent: `${prefix}:*` }
  }
  if (/^mcp__[^_]+.*__.+$/.test(toolName)) return { toolName }
  return null
}

/** 設定に書かれる表記。`Bash(gh pr:*)` / `mcp__github__create_issue` */
export function ruleLabel(rule: PermissionRule): string {
  return rule.ruleContent ? `${rule.toolName}(${rule.ruleContent})` : rule.toolName
}
