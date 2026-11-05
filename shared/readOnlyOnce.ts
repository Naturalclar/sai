// 「読むだけなら今回だけ許可」（#863）。ルールを作れない Claude の Bash の許可を、**Jev なしで**、
// `notReadOnly()` が読むだけと分かったときだけ、サーバが今回だけ許可する（覚えない）。入切は settings.json の `read_only_once`（既定は切）。
//
// 本物の Claude Code（2.1.318）で確かめた線（#863 のコメント）: Claude は `cd` を含む並びの書き込み・`for` の変数・`$( … )`・リダイレクト・
// 外のパス・守る置き場（`.claude` / `.git/hooks`）で、`allow` があっても聞いてくる。#864 はこれを部品ごとのルールでまねようとして、
// 穴が SAI 側に移った。なのでここは**ルールで当てる道を持たない**: 判定は `notReadOnly()` の 1 つ（知っているものだけ受ける読み取り）。
// 新しい読み方を作らない・拒否の一覧にしない・設定は読むだけ。
import type { Approval, NoRuleReason } from './types.ts'
import { NOT_READ_ONLY_TEXT, notReadOnly } from './bashReadOnly.ts'
import { ONCE_NEVER, jevAutoEligible } from './jev.ts'

export type ReadOnlyOnceDecision =
  /** 答えない（理由は reply.log に残す。`quiet` は記録にも残さない＝対象外の許可） */
  | { kind: 'skip'; reason: string; quiet?: boolean }
  /** ここまでは通った。置き場（cwd の realpath と worktree のトップ）を引いてから、もう一度呼ぶ */
  | { kind: 'place' }
  | { kind: 'once' }

/**
 * `ask` / `deny` のルールのうち、このコマンドに当たりうるものがあるか。**当たりうる側に倒す**:
 * Bash のルールの、パターンの最初の語（`Bash(git log:*)` なら `git`）が、コマンドのどこかに字として出てくれば当たりうる
 * （大文字小文字は見ない）。素の `Bash`・空・最初の語にワイルドカードがあるパターンは、何にでも当たりうる。Bash 以外のルールは見ない
 * （`Read` / `Edit` の `deny` に当たる Bash は Claude が自分で断るので、許可の預かりに来ない）
 */
export function guardMayMatch(rules: readonly string[], command: string): boolean {
  const text = command.toLowerCase()
  for (const raw of rules) {
    const rule = raw.trim()
    const open = rule.indexOf('(')
    const tool = (open < 0 ? rule : rule.slice(0, open)).trim()
    if (tool !== 'Bash') continue
    if (open < 0) return true
    const first = rule.slice(open + 1).replace(/\)\s*$/, '').trim().split(/[\s:]/)[0] ?? ''
    if (!first || /[*?[\]]/.test(first) || text.includes(first.toLowerCase())) return true
  }
  return false
}

/**
 * この許可に「読むだけなら今回だけ許可」をどうするか。`place` を渡さずに呼んで `place` が返ったら、置き場を引いてから渡し直す
 * （git を読むのは、ほかの条件を全部通ったときだけ）。
 * - `guards` は `ask` / `deny` のルール（`guardRules()`）。null は読めなかった（答えない）
 * - `noRule` はルールが空だった理由。ルールを作れる形（理由なし）は人の [常に許可] に任せ、`covered` / `not_bash` は回さない（#749 と同じ）
 */
export function readOnlyOnce(
  approval: Pick<Approval, 'tool_name' | 'agent' | 'answerable'> & Partial<Pick<Approval, 'input'>>,
  noRule: NoRuleReason | undefined,
  guards: readonly string[] | null,
  place?: { cwd: string; roots: readonly string[]; repo: string },
): ReadOnlyOnceDecision {
  if (!jevAutoEligible(approval)) return { kind: 'skip', reason: 'Claude の Bash でない', quiet: true }
  if (!noRule) return { kind: 'skip', reason: '「常に許可」のルールを作れる形（人が決める）', quiet: true }
  if (ONCE_NEVER.has(noRule)) return { kind: 'skip', reason: `ルールを作れない理由が ${noRule}` }
  const command = typeof approval.input?.command === 'string' ? approval.input.command : ''
  if (!command) return { kind: 'skip', reason: 'コマンドが読めない' }
  if (guards === null) return { kind: 'skip', reason: '止める側のルール（ask / deny）を読めなかった' }
  if (guardMayMatch(guards, command)) return { kind: 'skip', reason: '止める側のルール（ask / deny）に当たりうる' }
  if (!place) return { kind: 'place' }
  const why = notReadOnly(command, place.cwd, place.repo, place.roots)
  return why ? { kind: 'skip', reason: NOT_READ_ONLY_TEXT[why] } : { kind: 'once' }
}
