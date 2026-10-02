// フィードで、バブルの下の画像（#507）を引きに行くセッションを決める（#657）。純粋関数だけ（feedGallery.test.ts）
import { entityId } from '../../shared/entity.ts'
import { eventKind } from '../../shared/events.ts'
import { isRemoteHost } from '../../shared/host.ts'
import type { FeedRow } from './api'

/**
 * 一覧を引きに行くセッションの上限（新しい順）。フィードは複数のセッションが混ざるので、見えているセッションの数だけ
 * transcript / rollout を読みに行くことになる。古いセッションの画像は、そのセッションを開けば出る
 */
export const FEED_GALLERY_MAX = 20

/**
 * 画像の一覧（`GET /api/sessions/<id>/gallery`）を取りに行くセッションと、取り直しの目印（発言のバブルが出る一番新しい行の `ts`）。
 *
 * 目印はセッション画面の `useGallery` と同じ考え方で、**新しい発言が記録されたときだけ**変わる（3 秒のポーリングでは変わらない）。
 * 別のマシンの行は、transcript がここに無いので見ない（#114）。セッションが取れない行も見ない。
 * 返す順は目印の新しい順（画面の下＝いま見えている方から取りに行くため）で、`max` 個まで
 */
export function galleryStamps(rows: readonly FeedRow[], selfHost: string, max: number = FEED_GALLERY_MAX): Map<string, string> {
  const last = new Map<string, string>()
  for (const r of rows) {
    if (!r.session || isRemoteHost(r.host, selfHost)) continue
    const kind = eventKind(r.event, r.text)
    if (kind !== 'turn' && kind !== 'resume') continue
    const id = entityId(r.session, r.repo, r.ts)
    if ((last.get(id) ?? '') < r.ts) last.set(id, r.ts)
  }
  return new Map([...last].sort((a, b) => (a[1] < b[1] ? 1 : a[1] > b[1] ? -1 : 0)).slice(0, Math.max(0, max)))
}
