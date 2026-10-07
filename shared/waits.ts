// 「これが終わったら起こして」の待ち（#732）の決まりごと。エージェントがターンの終わりに預け、SAI が終わったのを確かめて
// そのセッションを **1 回だけ**起こす。いま待てるのは PR の CI だけ。
// 確かめるのはサーバ（`gh` の決まった形）で、待っている間はエージェントのターンを回さない（usage を使わない）。
// 置き場は `server/reply/waits.ts`、確かめる・起こすのは app.ts の `tickWaits()`。ここは純粋関数だけ（waits.test.ts）
import type { PrCheckState, Wait, WaitResult, WaitStatus } from './types.ts'

/** SAI が起こしたターンの本文の頭。人が打った文と見分ける（題名・「最後の入力」・↑ の履歴に使わない） */
export const WAIT_MARK = '【SAI 待ち】'
/** エージェントが待ちを預けるツールの名前（SAI が `claude -p` に渡す MCP） */
export const WAIT_FOR_TOOL = 'sai_wait_for'

// ---- 上限（**仮の値**。変えるならここ）
/** 1 つのセッションが同時に持てる待ち（確かめている・起こす前のもの） */
export const WAIT_MAX_PER_SESSION = 2
/** 1 つの待ちの長さ。過ぎたら起こさず、画面に出して終わる */
export const WAIT_MAX_MS = 2 * 60 * 60_000
/** 1 つのセッションを、待ちで自動で起こす回数（直近 24 時間）。超えたら起こさず画面に出す（人の「いま起こす」は数えない） */
export const WAIT_WAKES_PER_DAY = 6
export const WAIT_DAY_MS = 24 * 60 * 60_000
/** サーバが `gh` で確かめる間隔 */
export const WAIT_POLL_MS = 60_000
/** PR を出した直後はチェックがまだ載っていない。預かってからこの間は「チェックなし」を「まだ」と読む */
export const WAIT_EMPTY_GRACE_MS = 3 * 60_000
/**
 * 終わったのに起こせないまま（処理中・枠が少ない・許可を聞かないモードにした など）待つ長さ。過ぎたら見に行くのをやめて画面に残す
 * （起こせない待ちが、いつまでも同時の数の枠を使わないように）
 */
export const WAIT_READY_MAX_MS = 6 * 60 * 60_000
/** 起きたときにやることの 1 文の長さ */
export const WAIT_THEN_MAX = 300
/** 起こすときに渡す、落ちたチェックの名前の数 */
export const WAIT_FAILING_MAX = 5

/** サーバが持つ形。画面に出す `Wait` に、確かめる時刻・起こすときの宛先を足したもの */
export interface WaitState extends Wait {
  /** 最後に `gh` で読めた時刻。`ready` になったあとは、終わったと分かった時刻 */
  checked_at?: string
  /** 次に `gh` で確かめる時刻（`waiting` のときだけ） */
  next_check_at?: string
  /** 落ちたチェックの名前（起こすときに渡す。`WAIT_FAILING_MAX` まで） */
  failing?: string[]
  /** 起こすときの MCP の宛先（預けたときのこのサーバ自身） */
  url?: string
  /**
   * 「通った」「落ちた」を 1 回見たときの結果。**1 回見ただけでは信じない**（push・回し直しの直後は、前の結果や、速いチェックだけが
   * 載っていることがある）。次に確かめたときも同じなら終わりにする。変わったら数え直す
   */
  seen_once?: 'success' | 'failure'
}

/** まだ片付いていない（上限に数える・見に行く）か */
export function waitLive(status: WaitStatus): boolean {
  return status === 'waiting' || status === 'ready' || status === 'waking'
}

/** 人が「いま起こす」を押せるか。確かめている途中でも押せる（そのときは「まだ終わっていません」と渡す） */
export function waitWakeable(status: WaitStatus): boolean {
  return status === 'waiting' || status === 'ready' || status === 'halted'
}

/** `sai_wait_for` の引数を検査する。PR 番号と、起きたときにやることの 1 文だけ（長さ・間隔・回数は受けない） */
export function waitFromRequest(body: unknown): { pr: number; then: string } | { error: string } {
  const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>
  const pr = typeof b.pr === 'number' ? b.pr : typeof b.pr === 'string' && /^\d{1,9}$/.test(b.pr.trim()) ? Number(b.pr.trim()) : NaN
  if (!Number.isInteger(pr) || pr <= 0 || pr > 999_999_999) return { error: 'pr に PR の番号（正の整数）を入れてください' }
  const then = typeof b.then === 'string' ? b.then.trim().replace(/\s+/g, ' ') : ''
  if (!then) return { error: 'then に、起きたときにやることを 1 文で書いてください（例: 結果を読んで報告する）' }
  if (then.length > WAIT_THEN_MAX) return { error: `then は ${WAIT_THEN_MAX} 字までです。短くまとめてください` }
  return { pr, then }
}

/** 預かれない理由（数の上限・同じ PR をもう待っている）。無ければ空 */
export function waitLimitRefusal(own: readonly Pick<Wait, 'pr' | 'repo' | 'status'>[], repo: string, pr: number): string {
  const live = own.filter((w) => waitLive(w.status))
  if (live.some((w) => w.pr === pr && w.repo.toLowerCase() === repo.toLowerCase())) return `PR #${pr} の CI はもう待っています（終わったら 1 回起こします）`
  if (live.length >= WAIT_MAX_PER_SESSION) return `同時に待てるのは ${WAIT_MAX_PER_SESSION} 件までです（いま ${live.length} 件）`
  return ''
}

/** 直近 24 時間に自動で起こした回数が上限に達しているか */
export function wakesExhausted(wakes: readonly number[], now: number): boolean {
  return wakes.filter((at) => at > now - WAIT_DAY_MS).length >= WAIT_WAKES_PER_DAY
}

/** `gh pr view` を読んだもの（`server/git/prs.ts` の `ci()`） */
export interface PrCi {
  /** `OPEN` / `MERGED` / `CLOSED` */
  state: string
  checks: PrCheckState
  /** 落ちたチェックの名前 */
  failing: string[]
  /** まだ終わっていないチェックがある（`checks` が `failure` でも、残りが走っていることがある） */
  pending: boolean
}

/**
 * 確かめた結果から、待ちが終わったか。終わっていれば結果、まだなら null。
 * マージ・クローズされた PR はそこで終わり（CI を待つ意味が無い）。チェックが 1 つも無い PR は、
 * 預かってすぐ（`WAIT_EMPTY_GRACE_MS`）は「まだ載っていない」と読み、過ぎたら「チェックなし」で終わる。
 * **1 つ落ちていても、まだ走っているチェックがあれば「まだ」**（全部が終わってから 1 回だけ起こす。落ちた名前を全部渡す）
 */
export function waitOutcome(ci: PrCi, sinceMs: number, now: number): WaitResult | null {
  const state = ci.state.toUpperCase()
  if (state === 'MERGED') return 'merged'
  if (state === 'CLOSED') return 'closed'
  if (ci.pending) return null
  if (ci.checks === 'success' || ci.checks === 'failure') return ci.checks
  if (ci.checks === '' && now - sinceMs >= WAIT_EMPTY_GRACE_MS) return 'none'
  return null
}

const RESULT_TEXT: Record<WaitResult, string> = {
  success: 'CI は全部通りました',
  failure: 'CI が落ちました',
  none: 'この PR にはチェックがありません',
  merged: 'この PR はもうマージされています',
  closed: 'この PR は閉じられています',
}

/** 結果の 1 行（画面と、起こすときの本文の両方で使う）。まだ終わっていなければ空 */
export function waitResultText(result: WaitResult | undefined): string {
  return result ? RESULT_TEXT[result] : ''
}

/**
 * 起こすときに渡す本文。**結果の要点だけ**（状態・落ちたチェックの名前）で、ログは渡さない（#688。大きな出力を文脈に入れない）。
 * 頭は `WAIT_MARK`。起きたターンでやってよいのは結果を読んで報告するまで（マージはしない・別のセッションへ送らない・次の待ちを預けない）
 */
export function waitPrompt(w: Pick<WaitState, 'pr' | 'repo' | 'then' | 'result' | 'failing'>): string {
  const failing = w.result === 'failure' && w.failing && w.failing.length > 0 ? [`落ちたチェック: ${w.failing.slice(0, WAIT_FAILING_MAX).join(' / ')}`] : []
  return [
    `${WAIT_MARK}PR #${w.pr}（${w.repo}）: ${waitResultText(w.result) || 'CI はまだ終わっていません（人がいま起こしました）'}`,
    ...failing,
    '',
    `預けたときに書いたこと: ${w.then}`,
    '',
    'このターンでやるのは、結果を確かめて報告するまでです。マージはせず、別のセッションへ送ることも、次の待ちを預けることもしないでください（続きは人が決めます）。',
  ].join('\n')
}

/** SAI が待ちで起こしたターンの本文か */
export function isWaitPrompt(text: string): boolean {
  return text.trimStart().startsWith(WAIT_MARK)
}

/** 画面に出す短い形（`待ちが終わった: PR #12`）。待ちの本文でなければそのまま返す */
export function waitPromptLabel(text: string): string {
  if (!isWaitPrompt(text)) return text
  const n = /^PR #(\d+)/.exec(text.trimStart().slice(WAIT_MARK.length))?.[1]
  return n ? `待ちが終わった: PR #${n}` : '待ちが終わった'
}

/**
 * `success` / `failure` は続けて 2 回同じに見えてから信じる。1 回目なら「まだ」（null）を返す。
 * `last` は時間切れの前の最後の 1 回（そのときは 1 回でも信じる）
 */
export function waitConfirmed(seen: WaitResult | null, once: WaitState['seen_once'], last: boolean): WaitResult | null {
  if (seen !== 'success' && seen !== 'failure') return seen
  return last || once === seen ? seen : null
}

/** 終わった待ち・自動で起こした記録を置き場から落とすまで（人が片付けなかったものを溜めない） */
export const WAIT_KEEP_MS = 7 * 24 * 60 * 60_000

/** 画面に出す形（サーバだけが使う項目を落とす） */
export function waitView(w: WaitState): Wait {
  const { next_check_at: _next, failing: _failing, url: _url, seen_once: _seen, checked_at: _checked, ...view } = w
  return view
}

/** 画面の 1 行（`PR #12 の CI を待っています（あと 1 時間 20 分で諦めます）`） */
export function waitStatusLine(w: Wait, now: number): string {
  const head = `PR #${w.pr} の CI`
  if (w.status === 'waiting') {
    const left = Math.max(0, Math.ceil((Date.parse(w.deadline) - now) / 60_000))
    const span = left >= 60 ? `${Math.floor(left / 60)} 時間${left % 60 ? ` ${left % 60} 分` : ''}` : `${left} 分`
    return `${head} を待っています（あと ${span}で諦めます）`
  }
  if (w.status === 'ready') return `${head}: ${waitResultText(w.result)}。まだ起こしていません`
  if (w.status === 'waking') return `${head}: ${waitResultText(w.result) || '人がいま起こしました'}。起こしています`
  if (w.status === 'expired') return `${head} は、待てる時間のうちに終わりませんでした（起こしていません）`
  return `${head}: 起こせませんでした`
}
