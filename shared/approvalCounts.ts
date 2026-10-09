// 許可した回数（#445）。同じ許可（`gh pr create`・`pnpm test` …）を毎ターン聞かれるのが素通し（`bypassPermissions`）を選ぶ理由なので、
// **人が許可した回数**を「常に許可」で書かれるルールの組（`rulesKey()`）ごとに数え、何回目かをバブルに出して、
// 決めた回数からは「常に許可」を勧める。**勧めるだけで、ルールは書かない**（書くのは今までどおり人が「常に許可」を押したときだけ）。
// DOM に依存しないので approvalCounts.test.ts を node:test で回す
import type { Approval, ApprovalLogRow } from './types.ts'

/** この回数目の許可から「常に許可」を勧める */
export const APPROVAL_SUGGEST_AT = 3
/** 数えるのは直近この日数ぶん（古い許可で勧め続けない） */
export const APPROVAL_COUNT_DAYS = 30
/** 盾のモーダルに出す「よく許可しているがルールに無いもの」の数 */
export const APPROVAL_FREQUENT_MAX = 8

/** 組の区切り。ルールの表記に出てこない並び（`Bash(a:*) + Bash(b:*)`） */
const RULES_SEP = ' + '

/**
 * 数える鍵。**「常に許可」で書かれるルールの組**（#705。`Bash(pnpm test:*) + Bash(tee:*)`。1 つならその表記のまま）。
 * 前は先頭の語だけ（`Bash(cd:*)`）で束ねていたので、別々のコマンドが同じ回数に数えられ、効かないルールを勧め続けた。
 * 渡すのはサーバが組んだ `Approval.always`（Claude の `-p` の許可で、ルールが作れて、まだ設定に無いもの）。無ければ空（数えない）
 */
export function rulesKey(labels: readonly string[] | undefined): string {
  return (labels ?? []).join(RULES_SEP)
}

/** 鍵をルールの表記に戻す */
export function keyRules(key: string): string[] {
  return key.split(RULES_SEP).filter(Boolean)
}

/**
 * 勧めない鍵（#705）。`Bash(cd:*)` は一度も効かない: プロジェクトの中への `cd` はルール無しで通り、外への `cd` はルールがあっても聞かれる。
 * いまは書かれないが、前の記録（`approvals.jsonl`）に残っている分を盾のモーダルで勧め続けない
 */
export function neverSuggested(key: string): boolean {
  return keyRules(key).every((rule) => rule === 'Bash(cd:*)')
}

/** 記録の 1 行が、回数に数えるものか（人が許可した・ルールがある・cwd が分かる） */
export function countsTowardSuggest(row: ApprovalLogRow): boolean {
  return row.by === 'human' && row.behavior === 'allow' && !!row.rule && !!row.cwd
}

/** バブルに出す 1 行（`3 回目の許可（Bash(gh pr:*)）`）。初めてなら空（1 回目に数字は要らない） */
export function countNote(a: Pick<Approval, 'count' | 'suggest'>, label: string): string {
  if (!a.count || a.count < 2 || !label) return ''
  return `${a.count} 回目の許可（${label}）${a.suggest ? '。「常に許可」にすると、下のルールの範囲は聞かれなくなります' : ''}`
}

/** `Bash(gh pr:*)` / `Bash(gh pr *)` の前方一致の頭（`gh pr`）。前方一致の Bash のルールでなければ null */
function bashPrefix(rule: string): string | null {
  const m = /^Bash\((.*?)(?::\*| \*)\)$/.exec(rule)
  return m ? m[1]!.trim() : null
}

/**
 * そのルールが、もう許可のルールで覆われているか（#621 のレビュー）。同じ表記のほか、**より広いルール**
 * （`Bash` そのもの・`Bash(gh:*)` は `Bash(gh pr:*)` を覆う）と**別の書き方**（`Bash(gh pr *)`）も覆っている扱いにする。
 * 見るのは設定ファイルの許可のルールだけ（`SAI_CLAUDE_ARGS` の `--allowedTools` は見ない）
 */
export function ruleCovered(rule: string, allowed: readonly string[]): boolean {
  if (allowed.includes(rule)) return true
  const prefix = bashPrefix(rule)
  if (prefix === null) return false
  return allowed.some((a) => {
    if (a === 'Bash' || a === 'Bash(*)') return true
    const p = bashPrefix(a)
    return p !== null && (p === '' || prefix === p || prefix.startsWith(`${p} `))
  })
}

/** 組の全部が覆われているか（盾のモーダルの「よく許可しているがルールに無いもの」から外す） */
export function keyCovered(key: string, allowed: readonly string[]): boolean {
  return keyRules(key).every((rule) => ruleCovered(rule, allowed))
}
