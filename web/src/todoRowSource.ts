// 要対応の「終了」の行で、一言（要約）のもとの本文を開けるか（#537）。
import type { TodoItem } from '../../shared/todoItems.ts'

/**
 * 「元の文」を出す行なら、そのもとになったターン完了の行の `ts`。出さないなら空。
 *
 * 出すのは**行に一言が出ている `done` だけ**: `todoItems()` の `done` の文言は `idle || last_summary || last_text` の順なので、
 * `idle`（`入力待ち`…）が出ている行・一言の無い行（元から本文の 1 行目が出ている。一言を切ったセッションもこちら）は出さない。
 * 上段（`answer` / `watch`）は待ちの行の `text` そのもので、要約ではない。
 * `ts` は一言を引いた鍵（`last_turn_ts`）と同じにする（新しいターンが届いても、いま出ている一言のもとを開く）
 */
export function sourceTs(item: Pick<TodoItem, 'kind' | 'session'>): string {
  const s = item.session
  if (item.kind !== 'done' || !s || s.idle || !s.last_summary) return ''
  return s.last_turn_ts ?? ''
}
