// 返信中の許可・質問（Approval）の読み書き。サーバ（server/approvals/approvals.ts）が text を作り、
// 画面（web/src/ApprovalBubble.tsx）が AskUserQuestion の選択肢を出して answers を組み立てる。
// 文言は feed/record.py の待ちの行（tool_summary / waiting_text）と揃えてある
import { dumpsLikePython } from './pyjson.ts'
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
export interface AskOption {
  label: string
  description: string
  /** 推奨の印が付いていた（label 末尾の `(Recommended)` か description の書き出し）。label からは印を落としてある */
  recommended: boolean
}

export interface AskQuestion {
  /** Codex app-serverではresponseのキーになる。Claudeの質問には無い */
  id?: string
  question: string
  header: string
  options: AskOption[]
  multiSelect: boolean
  /** 選択肢に無い自由入力を受けられる */
  other: boolean
  /** 入力値を画面で隠す */
  secret: boolean
}

/** Codexは安定したquestion id、従来のClaudeは質問文を回答キーにする。 */
export const questionKey = (question: Pick<AskQuestion, 'id' | 'question'>) => question.id ?? question.question

/**
 * 推奨の印。CLI が決まった形で送ってくるわけではなく、質問を書くモデルの書き癖なので 2 通り拾う（実測 #195）:
 * - label の末尾に `(Recommended)`（英語でのお約束。日本語なら `（推奨）`）
 * - description の書き出しが `推奨` / `Recommended`（日本語で聞かれると実際にこちらになった）
 */
const RECOMMENDED_LABEL = /[（(]\s*(?:recommended|推奨)\s*[)）]\s*$/i
const RECOMMENDED_DESC = /^\s*(?:recommended|推奨)(?:[。.、,:：]|\s|$)/i

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
          .map((x) => {
            const given = String(x.label)
            const description = typeof x.description === 'string' ? x.description : ''
            const label = given.replace(RECOMMENDED_LABEL, '').trim() || given
            return { label, description, recommended: RECOMMENDED_LABEL.test(given) || RECOMMENDED_DESC.test(description) }
          })
      : []
    out.push({
      ...(typeof o.id === 'string' ? { id: o.id } : {}),
      question: o.question,
      header: typeof o.header === 'string' ? o.header : '',
      options,
      multiSelect: o.multiSelect === true,
      // Claudeの従来形式にはisOtherが無く、これまで常に「その他」を出していたので互換を保つ。
      other: o.isOther !== false,
      secret: o.isSecret === true,
    })
  }
  return out
}

/** 1問ぶんの答え。選んだ label に、選択肢に無い答え（その他の自由記入）を足したもの */
export function joinAnswer(labels: string[], other: string): string {
  return [...labels, other]
    .map((s) => s.trim())
    .filter(Boolean)
    .join(', ')
}

/** 全部の質問に答えが入ったか。CLI は 1 問でも欠けると「答えが無い」扱いにするので、送るのは揃ってから */
export function answersReady(questions: AskQuestion[], answers: Record<string, string>): boolean {
  return questions.length > 0 && questions.every((q) => (answers[questionKey(q)] ?? '').trim() !== '')
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
    // record.py の `json.dumps(..., ensure_ascii=False, sort_keys=True)` と同じ文字列にする（#147）。
    // `JSON.stringify` だと区切りの空白が無く、キーも挿入順なので、同じ 1 回の許可に対して
    // 待ちの行（record.py）と承認バブル（ここ）が別の文字で並ぶ
    return clip(dumpsLikePython(input), APPROVAL_TEXT_MAX)
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
 * AskUserQuestion の答え。CLI は `updatedInput.answers`（Claudeは質問文、Codexはquestion id → 答え。複数選択はカンマ区切り）を読む。
 * 元の questions をそのまま返さないと「答えが無い」扱いになる。
 * **label 以外の文字列（その他の自由記入）もそのままエージェントに届く**（#195 で実測）
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
