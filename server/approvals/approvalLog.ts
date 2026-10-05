// 許可に答えた記録（#445 / #582）。`<feed dir>/approvals.jsonl` に 1 行ずつ足し、起動時に読み直して回数を持つ。
// 書くのは時刻・エンティティ・cwd・ツール・ルールの表記・誰が答えたか・答え・待った秒数だけで、**コマンドの全文や本文は書かない**。
// 回数（#445）は「人が許可した・ルールがある・cwd が分かる」行を、cwd とルールごとに直近 APPROVAL_COUNT_DAYS 日ぶん数える。
// 派生の記録なので、ファイルを消しても数え直しになるだけ（記録の JSONL とは別物）
import { readFileSync } from 'node:fs'
import { appendFile } from 'node:fs/promises'
import { APPROVAL_COUNT_DAYS, APPROVAL_FREQUENT_MAX, countsTowardSuggest, keyCovered, neverSuggested } from '../../shared/approvalCounts.ts'
import type { ApprovalLogRow } from '../../shared/types.ts'

export const APPROVAL_LOG_FILE = 'approvals.jsonl'

const key = (cwd: string, rule: string) => `${cwd}\u0000${rule}`

export class ApprovalLog {
  private readonly path: string
  private readonly now: () => number
  /** cwd + ルール → 人が許可した時刻（ms） */
  private readonly allowed = new Map<string, number[]>()

  constructor(path: string, now: () => number = Date.now) {
    this.path = path
    this.now = now
    let text = ''
    try {
      text = readFileSync(path, 'utf-8')
    } catch {
      text = ''
    }
    for (const line of text.split('\n')) {
      if (!line.trim()) continue
      try {
        this.fold(JSON.parse(line) as ApprovalLogRow)
      } catch {
        // 壊れた行は飛ばす
      }
    }
  }

  private fold(row: ApprovalLogRow): void {
    if (!row || typeof row !== 'object' || !countsTowardSuggest(row)) return
    const at = Date.parse(row.ts)
    if (!Number.isFinite(at) || at < this.since()) return
    const k = key(row.cwd, row.rule)
    this.allowed.set(k, [...(this.allowed.get(k) ?? []), at])
  }

  private since(): number {
    return this.now() - APPROVAL_COUNT_DAYS * 86_400_000
  }

  /** 答えたことを 1 行足す。書けなくても答えは止めない */
  record(row: ApprovalLogRow): void {
    this.fold(row)
    void appendFile(this.path, `${JSON.stringify(row)}\n`).catch(() => {})
  }

  /** その cwd でそのルールを人が許可した回数（直近 APPROVAL_COUNT_DAYS 日） */
  count(cwd: string, rule: string): number {
    if (!cwd || !rule) return 0
    const since = this.since()
    return (this.allowed.get(key(cwd, rule)) ?? []).filter((at) => at >= since).length
  }

  /** その cwd でよく許可しているルール（多い順。2 回以上）。`allowed` はもう許可のルールにあるもの（覆われているものは出さない） */
  frequent(cwd: string, allowed: readonly string[]): { rule: string; count: number }[] {
    if (!cwd) return []
    const prefix = key(cwd, '')
    const out: { rule: string; count: number }[] = []
    for (const k of this.allowed.keys()) {
      if (!k.startsWith(prefix)) continue
      const rule = k.slice(prefix.length)
      const count = this.count(cwd, rule)
      if (count >= 2 && !neverSuggested(rule) && !keyCovered(rule, allowed)) out.push({ rule, count })
    }
    return out.sort((a, b) => b.count - a.count || a.rule.localeCompare(b.rule)).slice(0, APPROVAL_FREQUENT_MAX)
  }
}
