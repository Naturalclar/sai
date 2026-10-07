// セッションがいま何を持っているか（#727 の案 D の読む側）。`sai_sessions` の 1 行に足す短い印を作る。
// **SAI は持ち場を書いて持たない**: ブランチ・open な PR・届いている依頼から、機械で引けるものだけを出す（引けなければ出さない）。
// DOM にもファイルにも触らない純粋関数だけを置く（shared/holding.test.ts）
import type { PrCheckState, PrSummary } from './types.ts'

/** 1 行に出す issue の番号の数（多すぎる行にしない） */
export const HOLDING_ISSUES_MAX = 3

/** `sai_sessions` の 1 行に足すもの。どれも分かるときだけ */
export interface SessionHolding {
  /** そのセッションの worktree のブランチから出ている open な PR と、CI の状態 */
  pr?: { number: number; checks: PrCheckState; draft?: true }
  /** 持っていそうな issue の番号（ブランチ名・PR の題名・届いている依頼の 1 行目から引けたもの。古い順に重複なし） */
  issues?: number[]
  /** 空いている（処理中でない・預かりが無い・待ちが無い・未完の依頼も無い） */
  free?: true
  /** 別のセッションから頼まれて、まだ返していないメッセージの数（まだ送られていない預かりを含む） */
  asked?: number
}

/** ブランチから出ている open な PR。fork の同じ名前のブランチは結ばない（#548）。ブランチが分からなければ無し */
export function prOfBranch(prs: readonly PrSummary[] | null | undefined, branch: string): PrSummary | undefined {
  if (!prs || !branch) return undefined
  return prs.find((p) => p.head === branch && !p.cross)
}

/**
 * 持っていそうな issue の番号。**機械で引けるものだけ**（当て推量で埋めない）:
 * - ブランチ名の `issue-<番号>`（`issue-727-…`・`fix/issue_12`）
 * - PR の題名の `#<番号>`（その PR 自身の番号は除く）
 * - 届いていてまだ返していない依頼の **1 行目**の `#<番号>`（本文の途中に出てくる関連の番号まで拾わない）
 */
export function issueNumbers(branch: string, pr: Pick<PrSummary, 'number' | 'title'> | undefined, asks: readonly string[]): number[] {
  const out: number[] = []
  const add = (raw: string | undefined) => {
    const n = Number(raw)
    if (Number.isInteger(n) && n > 0 && n !== pr?.number && !out.includes(n)) out.push(n)
  }
  for (const m of branch.matchAll(/(?:^|[/_-])issue[-_]?(\d{1,6})(?!\d)/gi)) add(m[1])
  for (const m of (pr?.title ?? '').matchAll(/#(\d{1,6})(?!\d)/g)) add(m[1])
  for (const ask of asks) for (const m of (ask.trim().split('\n')[0] ?? '').matchAll(/#(\d{1,6})(?!\d)/g)) add(m[1])
  return out.slice(0, HOLDING_ISSUES_MAX)
}

/** 1 つのセッションぶんをまとめる。何も分からなければ空のオブジェクト */
export function holdingOf(input: {
  branch: string
  /** そのリポジトリの open な PR（引けていなければ null / undefined） */
  prs: readonly PrSummary[] | null | undefined
  /** 届いていてまだ返していない依頼の本文（古い順） */
  asks: readonly string[]
  /** 処理中・預かりあり・待ち（許可・質問・入力）のどれか */
  occupied: boolean
}): SessionHolding {
  const pr = prOfBranch(input.prs, input.branch)
  const issues = issueNumbers(input.branch, pr, input.asks)
  return {
    ...(pr ? { pr: { number: pr.number, checks: pr.checks, ...(pr.draft ? { draft: true as const } : {}) } } : {}),
    ...(issues.length > 0 ? { issues } : {}),
    ...(input.asks.length > 0 ? { asked: input.asks.length } : {}),
    ...(!input.occupied && input.asks.length === 0 ? { free: true as const } : {}),
  }
}

const CHECKS_LABEL: Record<PrCheckState, string> = { success: 'CI 緑', failure: 'CI 赤', pending: 'CI 待ち', '': '' }

/**
 * 1 行に足す文字（頭に空白を付ける。何も無ければ空）。`（空き） PR #728（CI 緑） issue #727 頼まれ中 1 件` の形。
 * 本文・題名は載せない（#688。一覧に大きな出力を足さない）
 */
export function holdingLabel(h: SessionHolding): string {
  const parts: string[] = []
  if (h.free) parts.push('（空き）')
  if (h.pr) {
    const notes = [h.pr.draft ? '下書き' : '', CHECKS_LABEL[h.pr.checks] ?? ''].filter(Boolean)
    parts.push(`PR #${h.pr.number}${notes.length > 0 ? `（${notes.join('・')}）` : ''}`)
  }
  if (h.issues && h.issues.length > 0) parts.push(`issue ${h.issues.map((n) => `#${n}`).join(', ')}`)
  if (h.asked) parts.push(`頼まれ中 ${h.asked} 件`)
  return parts.length > 0 ? ` ${parts.join(' ')}` : ''
}
