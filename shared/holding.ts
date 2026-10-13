// セッションがいま何を持っているか（#727 の案 D の読む側）。`sai_sessions` の 1 行に足す短い印を作る。
// **SAI は持ち場を書いて持たない**: ブランチ・open な PR・届いている依頼から、機械で引けるものだけを出す（引けなければ出さない）。
// DOM にもファイルにも触らない純粋関数だけを置く（shared/holding.test.ts）
import type { HoldingWhy, PrCheckState, PrSummary, SessionHolding } from './types.ts'

/** 1 行に出す issue の番号の数（多すぎる行にしない） */
export const HOLDING_ISSUES_MAX = 3

/** ブランチから出ている open な PR。fork の同じ名前のブランチは結ばない（#548）。ブランチが分からなければ無し */
export function prOfBranch(prs: readonly PrSummary[] | null | undefined, branch: string): PrSummary | undefined {
  if (!prs || !branch) return undefined
  return prs.find((p) => p.head === branch && !p.cross)
}

/**
 * 持っていそうな issue の番号。**機械で引けるものだけ**（当て推量で埋めない）:
 * - ブランチ名の `issue-<番号>`（`issue-727-…`・`fix/issue_12`）
 * - PR の題名の、**括弧の中**の `#<番号>`（`… (#727)`・`（#727 の案 A）`。squash の題名の決まった形。括弧の外の
 *   「#728 の上に積む」は別の PR のことが多いので拾わない。括弧の中でも `PR #N` は拾わない。その PR 自身の番号も除く）
 * - 届いていてまだ返していない依頼の 1 行目の、**行の頭の `#<番号>`** か **`issue #<番号>`**（`#727 に着手してください。`）。
 *   `PR #734 をレビューして` の番号は PR なので拾わない。本文の途中に出てくる関連の番号も拾わない
 */
export function issueNumbers(branch: string, pr: Pick<PrSummary, 'number' | 'title'> | undefined, asks: readonly string[]): number[] {
  const out: number[] = []
  const add = (raw: string | undefined) => {
    const n = Number(raw)
    if (Number.isInteger(n) && n > 0 && n !== pr?.number && !out.includes(n)) out.push(n)
  }
  for (const m of branch.matchAll(/(?:^|[/_-])issue[-_]?(\d{1,6})(?!\d)/gi)) add(m[1])
  for (const group of (pr?.title ?? '').matchAll(/[（(]([^（()）]*)[)）]/g)) for (const m of (group[1] ?? '').matchAll(/(?<!(?:PRs?|pull request|プルリク(?:エスト)?)\s*)(?<![A-Za-z0-9])#(\d{1,6})(?!\d)/gi)) add(m[1])
  for (const ask of asks) {
    const line = ask.trim().split('\n')[0] ?? ''
    for (const m of line.matchAll(/(?:^\s*|(?<![A-Za-z])issue\s*)#(\d{1,6})(?!\d)/gi)) add(m[1])
  }
  return out.slice(0, HOLDING_ISSUES_MAX)
}

/** 1 つのセッションぶんをまとめる。何も分からなければ空のオブジェクト */
export function holdingOf(input: {
  branch: string
  /** そのリポジトリの open な PR（引けていなければ null / undefined） */
  prs: readonly PrSummary[] | null | undefined
  /** 届いていてまだ返していない依頼の本文（古い順） */
  asks: readonly string[]
  /** 処理中・端末のターン・待ち（許可・質問・入力）・預かりあり・止められないバックグラウンドのどれかに当たれば、その理由。当たらなければ空 */
  occupied: HoldingWhy | ''
  /**
   * worktree の作業の状態（#795。`server/git/diff.ts` の `workState()`）。省けば見ない（別のマシンなど）:
   * `none` = git のリポジトリでない、`clean` = 作りかけ無し（マージ済みのブランチが残っているだけも含む）、
   * `dirty` = コミットしていない変更、`ahead` = base に入っていないコミット、`unknown` = 読めなかった
   */
  work?: WorkState
  /** 頼める相手か（別のマシン・送れないセッションは false。省けば true）。頼めない相手に「空き」は付けない */
  sendable?: boolean
}): SessionHolding {
  const pr = prOfBranch(input.prs, input.branch)
  const issues = issueNumbers(input.branch, pr, input.asks)
  // **「空き」はここ 1 か所で決める**（#795。一覧の印も、送る時点の確かめも、この答えを読む）
  const why = notFreeWhy({ occupied: input.occupied, asked: input.asks.length, work: input.work, inPr: Boolean(pr) })
  return {
    ...(pr ? { pr: { number: pr.number, checks: pr.checks, ...(pr.draft ? { draft: true as const } : {}) } } : {}),
    ...(issues.length > 0 ? { issues } : {}),
    ...(input.asks.length > 0 ? { asked: input.asks.length } : {}),
    // 頼めない相手（別のマシン・送れないセッション）には、空きも理由も付けない
    ...(input.sendable === false ? {} : why ? { why } : { free: true as const }),
  }
}

/** worktree の作業の状態（#795）。組むのは `server/git/diff.ts` の `workState()` */
export type WorkState = 'none' | 'clean' | 'dirty' | 'ahead' | 'unknown'

/**
 * 空きでない理由（#795）。空きなら空文字。**分からないとき（`unknown`）は空きにしない**。
 * - コミットしていない変更（`dirty`）は、PR が出ていても空きにしない
 * - base に入っていないコミット（`ahead`）は、そのブランチから open な PR が出ていれば作りかけに数えない
 *   （PR の一覧が引けなかったときは PR が無いのと同じ扱い = 空きにしない）
 * - マージ済みのブランチが残っているだけ（`clean`）・git のリポジトリでない（`none`）は空き
 */
export function notFreeWhy(input: { occupied: HoldingWhy | ''; asked: number; work?: WorkState | undefined; inPr: boolean }): HoldingWhy | '' {
  if (input.occupied) return input.occupied
  if (input.asked > 0) return 'asked'
  if (input.work === 'dirty') return 'dirty'
  if (input.work === 'ahead' && !input.inPr) return 'unpushed'
  if (input.work === 'unknown') return 'unknown'
  return ''
}

/** `sai_sessions` の説明に足す文（#795。セッション同士の口と `/mcp` で同じ文） */
export const FREE_NOTE = '「（空き）」＝処理中でも待ちでもなく、頼まれて未完のものも、コミットしていない変更・PR になっていないコミットも無い。空きでない相手には短い理由が 1 つ付く（「（端末で作業中）」「（未コミットの変更）」など）'
/** `sai_send` の説明に足す文（#795。同上） */
export const START_ASK_NOTE = '**着手の依頼（1 行目が「#N に着手してください。」の形）は、送る時点で相手が空きでなければ送らずに理由を返す**（相手には何も届かない。一覧で見たときから相手の読み直す量が大きく増えていたときも同じ）。断られたら sai_sessions を引き直して空きの相手を選ぶか、人に確かめる（無理に送る引数は無い）'

/** 理由の短い語（#795。一覧の 1 行と、送らなかったときの文で同じ語を使う） */
export const WHY_LABEL: Record<HoldingWhy, string> = {
  busy: '処理中',
  terminal: '端末で作業中',
  waiting: '待ち',
  queued: '預かりあり',
  asked: '頼まれ中',
  background: '裏で動作中',
  dirty: '未コミットの変更',
  unpushed: 'PR 前のコミット',
  unknown: '状態不明',
}

/**
 * 着手の形の依頼を、空きでない相手に送らなかったときに送り元へ返す文（#795）。相手には何もしていない。
 * 別のリポジトリの相手（`hidden`）には理由の中身を出さない
 */
export function startRefusal(why: HoldingWhy, hidden = false): string {
  const reason = hidden ? '別のリポジトリの相手の理由は出しません' : WHY_LABEL[why]
  return `相手は空きではないので、着手の依頼は送りませんでした（${reason}）。相手には何も届いていません。sai_sessions を引き直して空きの相手を選ぶか、人に確かめてください`
}

/** 送り元が一覧で見た量から、これを超えて増えていたら（倍率）着手の依頼を送らない（#795。仮の既定） */
export const SEEN_CONTEXT_FACTOR = 2
/** 上の倍率に加えて、いまの量がこれを超えているときだけ断る（トークン。#795。仮の既定）。小さい相手の倍は気にしない */
export const SEEN_CONTEXT_MIN_TOKENS = 300_000

/**
 * 相手の読み直す量が、送り元が最後に一覧で見た値から大きく増えているか（#795）。見ていなければ（0）増えたとは言わない
 */
export function grownSinceSeen(seen: number, now: number): boolean {
  return seen > 0 && now > seen * SEEN_CONTEXT_FACTOR && now > SEEN_CONTEXT_MIN_TOKENS
}

/** 上に当たって送らなかったときの文（#795。量は呼び出し側が `tokensLabel()` で作る） */
export function grownRefusal(seenLabel: string, nowLabel: string): string {
  return `相手の読み直す量が、一覧で見たとき（${seenLabel}）から大きく増えています（いま ${nowLabel}）。別の作業が入った見込みなので、着手の依頼は送りませんでした。相手には何も届いていません。sai_sessions を引き直して確かめてください`
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
  // 空きでない理由（#795）。行にもう出ているもの（「（処理中）」・「頼まれ中 N 件」）は重ねない
  if (h.why && h.why !== 'busy' && h.why !== 'asked') parts.push(`（${WHY_LABEL[h.why]}）`)
  return parts.length > 0 ? ` ${parts.join(' ')}` : ''
}
