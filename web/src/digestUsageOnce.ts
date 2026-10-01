// 使われたかの合図（#446）を、同じ一言・同じ案について 1 回だけ数えるための純粋関数（digestUsageOnce.test.ts）
import type { DigestUsageReason } from '../../shared/digestFeedback.ts'

/**
 * まだ数えていない組なら覚えて true。**同じ一言・同じ案は、画面を開いている間 1 回だけ数える**
 * （詳細を開け閉めするたび・受け取って消してまた受け取るたびに増やさない）
 */
export function firstUse(seen: Set<string>, key: string, reason: DigestUsageReason): boolean {
  if (!key) return false
  const id = `${reason}|${key}`
  if (seen.has(id)) return false
  seen.add(id)
  return true
}
