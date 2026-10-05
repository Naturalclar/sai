import { eventKind } from '../../shared/events.ts'
import type { FeedRow, SessionProgressResponse } from './api'

/**
 * 端末で打ったターンが動いていそうか（#302）。そのセッションの行で、一番新しい（`other` を除く）行が
 * 人の入力（`resume`。`UserPromptSubmit`）なら、その ts を返す。ターン完了や待ちの行が最後なら空。
 *
 * SAI から送った返信なら `replying` で分かるが、端末で打ったターンは SAI が起動していないので、行しか手がかりが無い。
 * 入力のあとターン完了が来ないまま残ることがある（Esc で止めた。#302 の実測で 536 件中 13 件）ので、
 * **これだけで「処理中」と出さない**。本当に動いているかはサーバの progress の `active` で確かめる
 */
export function openPromptSince(rows: readonly FeedRow[]): string {
  let latest: FeedRow | null = null
  for (const row of rows) {
    if (eventKind(row.event, row.text) === 'other') continue
    if (!latest || row.ts > latest.ts) latest = row
  }
  return latest && eventKind(latest.event, latest.text) === 'resume' ? latest.ts : ''
}

/**
 * 端末で打った **Codex** のターンが動いていれば、その始まりの時刻（#693）。Codex は入力の行を書かない（`user_text` は
 * ターン完了の行に載る）ので、`openPromptSince()` では拾えない。rollout の開いているターンの始まり（`turn_since`）を起点にする。
 *
 * 出すのは、progress が動いている（`active`）と言っていて、**その始まりが最後のターン完了の行より後**のときだけ
 * （終わったターンを「処理中」にしない。行の `ts` は秒までなので、同じ秒は終わったものとして扱う）。待ちの行は閉じない
 * （許可で止まっている間もターンは続いている）
 */
export function codexTurnSince(rows: readonly FeedRow[], progress: Pick<SessionProgressResponse, 'active' | 'turn_since'> | null): string {
  if (!progress?.active || !progress.turn_since) return ''
  const started = Date.parse(progress.turn_since)
  if (Number.isNaN(started)) return ''
  let lastTurn = -Infinity
  for (const row of rows) {
    if (eventKind(row.event, row.text) !== 'turn') continue
    const t = Date.parse(row.ts)
    if (t > lastTurn) lastTurn = t
  }
  // 行は秒まで。ターン完了の行の秒の終わりまでに始まったターンは、その行のターン
  return started >= lastTurn + 1000 ? progress.turn_since : ''
}
