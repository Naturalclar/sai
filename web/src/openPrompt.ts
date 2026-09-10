import { eventKind } from '../../shared/events.ts'
import type { FeedRow } from './api'

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
    if (eventKind(row.event) === 'other') continue
    if (!latest || row.ts > latest.ts) latest = row
  }
  return latest && eventKind(latest.event) === 'resume' ? latest.ts : ''
}
