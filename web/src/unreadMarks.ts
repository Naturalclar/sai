// 未読の印（#502）の画面側の判定。線をどこに引くか・いま既読にしてよいか
import { isUnreadCandidate, rowMs } from '../../shared/unread.ts'
import type { Utterance } from './chatGroups.ts'

/**
 * 「ここから未読」の線を引く発言の鍵。`after`（ミリ秒）より新しい、最初の**エージェントの返答**（待ちのバブル・自分の入力・
 * 終わりの区切りは数えない）。無ければ空。並びは描く順（古い → 新しい）
 */
export function firstUnreadKey(items: readonly Utterance[], after: number | undefined): string {
  if (after === undefined || !Number.isFinite(after)) return ''
  for (const u of items) {
    if (u.speaker === 'me' || u.waiting || u.ended) continue
    if (!isUnreadCandidate(u.row)) continue
    if (rowMs(u.row.ts) > after) return u.key
  }
  return ''
}

/**
 * 最下部まで見たときに既読の印を送るか。**一番新しい返答が印より新しいときだけ**送り、同じ時刻は 2 度送らない（3 秒の
 * ポーリングのたびに PUT しない）。「ここから未読にする」を押したあとは、そのセッションを離れるまで送らない（押した直後に
 * 最下部にいて、すぐ既読に戻ってしまうため）
 */
export function readToSend(latest: number, readAt: number | undefined, sent: number, held: boolean): number | null {
  if (held || !Number.isFinite(latest)) return null
  if (readAt !== undefined && latest <= readAt) return null
  if (latest <= sent) return null
  return latest
}
