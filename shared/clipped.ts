import type { ClippedField, FeedRow } from './types.ts'

/**
 * その項目の本文が record.py に切られたか（#358）。
 *
 * 上限を上げたので普段は立たないが、立ったときに黙って落とすと「そこで終わった」のか
 * 「切られた」のかが読めないので、画面が末尾に印を出すための判定をここに 1 つだけ置く。
 * 古い行（`clipped` を書かない record.py が書いたもの）は false（切れていても分からないので、嘘はつかない）。
 */
export function wasClipped(row: Pick<FeedRow, 'clipped'>, field: ClippedField): boolean {
  return Array.isArray(row.clipped) && row.clipped.includes(field)
}
