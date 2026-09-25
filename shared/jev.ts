// 許可のバブルに、許可して問題なさそうかを Jev（TypeSafe AI の判定専用モデル）で予想した確率を添える（#491）。
// ここは純粋関数だけ（何を聞くか・何を送るか・答えをどう読むか）。送るのは server/approvals/jev.ts。
//
// **Jev は外部 API なので、ここで組み立てた文が外に出る**（「SAI は外に出さない」の例外。入切できて既定は入、
// 鍵 JEV_API_KEY が無ければ何も送らない）。そのため送るものを絞る: 許可の要約・コマンド・理由・Codex のダイアログの中身まで。
// **ファイルの中身（Write / Edit の本文）と cwd は送らない**（要約の `text` には入っていない。input は拾う項目を名指しする）
import type { Approval } from './types.ts'

/**
 * Jev に聞く文。**状態について書いた 1 つの主張**にする（Jev は「この文がどれだけ本当か」を 0..1 で返す）。
 * 英文なのはベンダーが日本語は精度が落ちると言っているため（作りもの 7 件で日本語もほぼ同じ値だったが、英文を採る）
 */
export const JEV_SAFE_STATEMENT = 'Allowing this action is safe: it does not destroy data, leak secrets, or make irreversible changes'

/** 送る文の上限（コマンドが長くても、送る量を抑える） */
export const JEV_STATE_MAX = 2000

/** 1 つの項目の上限 */
const FIELD_MAX = 1000

/** 「問題ないか」の話ではない（答えを選ぶだけの）もの。聞かない */
const NOT_PERMISSIONS = new Set(['AskUserQuestion', 'ExitPlanMode'])

/**
 * この許可を Jev に聞くか。**SAI が答えられる許可だけ**（検出専用＝`answerable: false` は聞かない。
 * 押せないバブルに確率を出しても使い道が無く、送る分だけ外に出る）。質問も聞かない
 */
export function jevAsks(approval: Approval): boolean {
  return approval.answerable !== false && !NOT_PERMISSIONS.has(approval.tool_name)
}

const clip = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max)}…` : text)

const field = (input: Record<string, unknown>, key: string): string => {
  const value = input[key]
  return typeof value === 'string' ? value.trim() : ''
}

/**
 * Jev に送る「状態」の文。拾うのは要約（`text`）と、名指しした項目（コマンド・説明・理由）とダイアログの中身だけ。
 * **input を丸ごとは送らない**（Write の `content` や Edit の `old_string` / `new_string` はファイルの中身そのもの）
 */
export function jevState(approval: Approval): string {
  const input = approval.input ?? {}
  const lines = [`A coding agent (${approval.agent ?? 'claude'}) is asking the user for permission.`, `Request: ${clip(approval.text, FIELD_MAX)}`]
  const command = field(input, 'command')
  // 要約に収まっていなければ全部を足す（要約は長いコマンドを切っていることがある）
  if (command && !approval.text.includes(command)) lines.push(`Command: ${clip(command, FIELD_MAX)}`)
  const description = field(input, 'description')
  if (description) lines.push(`Description: ${clip(description, FIELD_MAX)}`)
  const reason = field(input, 'reason')
  if (reason) lines.push(`Reason: ${clip(reason, FIELD_MAX)}`)
  const dialog = approval.dialog
  if (dialog) {
    if (dialog.title) lines.push(`Dialog: ${clip(dialog.title, FIELD_MAX)}`)
    if (dialog.detail) lines.push(clip(dialog.detail, FIELD_MAX))
    if (dialog.command) lines.push(`Command: ${clip(dialog.command, FIELD_MAX)}`)
  }
  return clip(lines.join('\n'), JEV_STATE_MAX)
}

/** 画面の色分け。**判断はしない**（押すのは人）。どこで区切るかだけをここに 1 つ置く */
export type JevLevel = 'safe' | 'unsure' | 'risky'

/** これ以上なら「問題なさそう」 */
export const JEV_SAFE_AT = 0.8
/** これ未満なら「危なそう」 */
export const JEV_RISKY_BELOW = 0.3

export function jevLevel(safe: number): JevLevel {
  if (safe >= JEV_SAFE_AT) return 'safe'
  if (safe < JEV_RISKY_BELOW) return 'risky'
  return 'unsure'
}

/** 画面に出す 1 行（`問題なさそう 97%`）。確率は整数の % に丸める */
export function jevLabel(safe: number): string {
  const percent = Math.round(safe * 100)
  const level = jevLevel(safe)
  return `${level === 'safe' ? '問題なさそう' : level === 'risky' ? '危なそう' : '判断が割れる'} ${percent}%`
}

/**
 * Jev の応答（`{ answers: { safe: { type: 'noul', noul: 0.97 } } }`）から確率を取り出す。
 * 形が違えば null（**分からないものを 0 や 1 にしない**）
 */
export function jevSafeOf(body: unknown, name: string): number | null {
  if (!body || typeof body !== 'object') return null
  const answers = (body as { answers?: unknown }).answers
  if (!answers || typeof answers !== 'object') return null
  const answer = (answers as Record<string, unknown>)[name]
  if (!answer || typeof answer !== 'object') return null
  const noul = (answer as { noul?: unknown }).noul
  return typeof noul === 'number' && Number.isFinite(noul) && noul >= 0 && noul <= 1 ? noul : null
}
