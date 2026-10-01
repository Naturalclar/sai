// 一言と「次の案」が使われたかを数える（#446）。「詳細」を開いた・案を受け取った、の 2 つを
// 「変？」と同じ口（POST /api/digest/feedback）に送り、手元の digest-feedback.jsonl に溜める（外には出ない）。
// 画面には何も出さない（失敗しても黙って捨てる。数えるためだけに操作を止めない）
import type { DigestUsageReason } from '../../shared/digestFeedback.ts'
import { api } from './api'
import { firstUse } from './digestUsageOnce.ts'

const seen = new Set<string>()

export function reportDigestUsage(key: string | undefined, reason: DigestUsageReason): void {
  if (!key || !firstUse(seen, key, reason)) return
  void api.digestFeedback(key, reason).catch(() => {})
}
