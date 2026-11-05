// ルールを作れない Bash を「今回だけ許可」してよいかの判定（#749 の Jev の道と、#863 の「読むだけなら今回だけ許可」の両方が使う 1 つ）。
// 「読むだけなら今回だけ許可」は、settings.json の `read_only_once` が入のときだけ、**Jev なしで**サーバが今回だけ許可する（覚えない。既定は切）。
//
// 本物の Claude Code（2.1.318）で確かめた線（#863 のコメント）: Claude は `cd` を含む並びの書き込み・`for` の変数・`$( … )`・リダイレクト・
// 外のパス・守る置き場（`.claude` / `.git/hooks`）で、`allow` があっても聞いてくる。#864 はこれを部品ごとのルールでまねようとして、
// 穴が SAI 側に移った。なのでここは**ルールで当てる道を持たない**: 読むだけかは `notReadOnly()` の 1 つ（知っているものだけ受ける読み取り）で決める。
// 新しい読み方を作らない・拒否の一覧にしない・設定は読むだけ。
import type { Approval, NoRuleReason } from './types.ts'
import { NOT_READ_ONLY_TEXT, notReadOnly } from './bashReadOnly.ts'

/**
 * ルールが空だった理由のうち、「今回だけ許可」に回さないもの（#749）。
 * `covered` はルールがもう設定にあるのに聞かれている形（Claude の側が当てていない何かがある）、`not_bash` は Bash でない
 */
export const ONCE_NEVER = new Set<string>(['covered', 'not_bash'])

/** Claude の `-p` の Bash で、画面から答えられるもの（自動で答えてよい種類。`jevAutoEligible()` も同じ） */
export function isClaudeBash(approval: Pick<Approval, 'tool_name' | 'agent' | 'answerable'>): boolean {
  return (approval.agent ?? 'claude') === 'claude' && approval.answerable !== false && approval.tool_name === 'Bash'
}

/**
 * `ask` / `deny` のルールのうち、このコマンドに当たりうるものがあるか。**当たりうる側に倒す**:
 * ルールの文字の中の `Bash` を全部見て（運用者の引数で 1 つの語に並べた形・`,` で区切った形もある）、
 * パターンの最初の語（`Bash(git log:*)` なら `git`。引用符・バックスラッシュは外す）が、コマンドを語に割ったどれかと同じなら当たりうる
 * （大文字小文字は見ない。パスの形は最後の階層でも比べる。`--format=%H` の中の `rm` のような語の一部では当たらない）。括弧の無い `Bash`・空・最初の語にワイルドカードがあるパターンは、何にでも当たりうる。Bash 以外のルールは見ない
 * （`Read` / `Edit` の `deny` に当たる Bash は Claude が自分で断るので、許可の預かりに来ない）
 */
export function guardMayMatch(rules: readonly string[], command: string): boolean {
  // コマンドを語に割る（引用符・区切り・`$( … )`・`=` で割る。パスの形 `/usr/bin/git` は最後の階層でも比べる）
  const words = new Set<string>()
  for (const w of command.toLowerCase().split(/[^a-z0-9_./+@%-]+/)) {
    if (!w) continue
    words.add(w)
    words.add(w.slice(w.lastIndexOf('/') + 1))
  }
  for (const rule of rules) {
    for (const m of rule.matchAll(/(?:^|[^A-Za-z0-9_])Bash(?![A-Za-z0-9_])(\(([^)]*)\)?)?/g)) {
      if (m[1] === undefined) return true
      const first = (m[2] ?? '').replace(/["'\\]/g, '').trim().split(/[\s:]/)[0]?.toLowerCase() ?? ''
      if (!first || /[*?[\]]/.test(first) || words.has(first) || words.has(first.slice(first.lastIndexOf('/') + 1))) return true
    }
  }
  return false
}

/** 答えない理由。`quiet` は対象外の許可（記録にも残さない） */
export interface OnceSkip {
  reason: string
  quiet?: boolean
}

/**
 * 置き場（git）を引く前に分かる分。null なら置き場を引いて `onceNotReadOnly()` へ（git を読むのは、ほかを全部通ったときだけ）。
 * - `noRule` はルールが空だった理由。理由が無い（ルールを作れる形）は人の [常に許可] に任せる。`covered` / `not_bash` は回さない（#749）
 * - `guards` は止める側のルール（`ask` / `deny`。`guardRules()`）。null / 省略は読めなかった（答えない）
 */
export function onceBlocked(
  approval: Pick<Approval, 'tool_name' | 'agent' | 'answerable'> & Partial<Pick<Approval, 'input'>>,
  noRule: NoRuleReason | undefined,
  guards: readonly string[] | null | undefined,
): OnceSkip | null {
  if (!isClaudeBash(approval)) return { reason: 'Claude の Bash でない', quiet: true }
  if (!noRule) return { reason: '「常に許可」のルールを作れる形（人が決める）', quiet: true }
  if (ONCE_NEVER.has(noRule)) return { reason: `ルールを作れない理由が ${noRule}` }
  const command = typeof approval.input?.command === 'string' ? approval.input.command : ''
  if (!command) return { reason: 'コマンドが読めない' }
  if (!guards) return { reason: '止める側のルール（ask / deny）を読めなかった' }
  if (guardMayMatch(guards, command)) return { reason: '止める側のルール（ask / deny）に当たりうる' }
  return null
}

/** 置き場（cwd の realpath・worktree のトップ・GitHub のリポジトリ）を引いたあとの分。読むだけと分かれば空、分からなければ理由 */
export function onceNotReadOnly(
  approval: Partial<Pick<Approval, 'input'>>,
  place: { cwd: string; roots?: readonly string[]; repo?: string },
): string {
  const command = typeof approval.input?.command === 'string' ? approval.input.command : ''
  const why = command ? notReadOnly(command, place.cwd, place.repo ?? '', place.roots ?? []) : 'syntax'
  return why ? NOT_READ_ONLY_TEXT[why] : ''
}
