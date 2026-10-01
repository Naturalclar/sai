// ターンは終わっているのに、ターン完了（Stop）の行が記録されなかったセッション（#614）。
// Stop フックが間に合わないと行が落ち、SAI には「人の入力のあとに何も無い」まま見える（#613）。
// **分かるときだけ**印を出す: transcript の上でそのターンが閉じている（`end_turn`）のに、記録の最後の行が人の入力のまま。
// 止めた（Esc）・殺された・まだ回っている、は transcript が閉じていないので出さない。SAI は行を書かない（印は応答に載せるだけ）
import type { SessionSummary } from './types.ts'
import { rowMs } from './unread.ts'

/** ターンが閉じてから、行が来るのを待つ長さ。`record.py` は 15 秒で諦めるので、それより十分長く */
export const STOP_MISSING_AFTER_MS = 60_000

type Candidate = Pick<SessionSummary, 'agent' | 'last_kind' | 'end' | 'last_user_ts'>

/**
 * 調べる価値があるか（transcript を読む前の、行だけで分かる条件）。
 * 最後の行が**入力の載った入力の行**（Claude の `UserPromptSubmit`）で、そこから待つ長さが過ぎている。
 * Claude だけ（Codex / OpenCode は入力の行を書かないので、この形にならない）
 */
export function stopMissingCandidate(s: Candidate, now: number): boolean {
  if (s.agent !== 'claude' || s.last_kind !== 'resume') return false
  if (!s.last_user_ts || s.last_user_ts !== s.end) return false
  const at = rowMs(s.end)
  return Number.isFinite(at) && now - at >= STOP_MISSING_AFTER_MS
}

export interface StopMissingInput {
  /** SAI がそのセッションの返信を回している（子が居る）。居るあいだは出さない */
  busy: boolean
  /** transcript の上で最後のターンが閉じた時刻（`SessionProgressResponse.closed_at`）。閉じていない・読めなければ空 */
  closedAt: string
  now: number
}

/**
 * 印を出すか。候補で、SAI が回しておらず、**その入力より後に** transcript のターンが閉じていて、閉じてから待つ長さが過ぎている。
 * transcript が読めない・閉じていない（まだ回っている・Esc で止めた・途中で落ちた）ときは出さない
 */
export function stopMissing(s: Candidate, input: StopMissingInput): boolean {
  if (!stopMissingCandidate(s, input.now) || input.busy) return false
  const closed = Date.parse(input.closedAt)
  if (!Number.isFinite(closed)) return false
  // 行の ts は秒まで。閉じたのが入力の行より前なら、それは前のターン
  return closed >= rowMs(s.end) && input.now - closed >= STOP_MISSING_AFTER_MS
}
