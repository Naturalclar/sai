// セッション画面で描く行を直近に絞る（#477）。
//
// 行の多いセッション（手元で 1045 行・本文 43 万字、DOM 2.3 万要素）は、3 秒のポーリングのたびにチャット全体を
// 描き直すので、遅い端末では打鍵が 150ms 止まる。そこで詳細の API は既定で**直近 `RECENT_DAYS` 日の行だけ**を返し、
// それより前は画面の「前の 7 日を表示」で必要なときに取る。同じセッションで 7 日より前を見る回は少なく、
// 手元の一番大きいセッションは 1045 行 → 176 行になる。

/** セッション画面が最初に描く日数。押すたびにこの日数ずつさかのぼる */
export const RECENT_DAYS = 7

const DAY_MS = 24 * 60 * 60 * 1000

/**
 * 直近 `recentDays` 日（`nowMs` から）の行と、それより前で落とした行の数。
 * `focusTs`（検索の飛び先）があれば、その行まで必ず含める（落とすと飛べない）。
 * 時刻の読めない行は落とさない（どちら側か分からないものを消さない）
 */
export function recentRows<T extends { ts?: string }>(rows: readonly T[], recentDays: number, nowMs: number, focusTs = ''): { rows: T[]; older: number } {
  let cutoff = nowMs - recentDays * DAY_MS
  const focus = Date.parse(focusTs)
  if (!Number.isNaN(focus)) cutoff = Math.min(cutoff, focus)
  const kept: T[] = []
  let older = 0
  for (const row of rows) {
    const at = Date.parse(row.ts ?? '')
    if (!Number.isNaN(at) && at < cutoff) older++
    else kept.push(row)
  }
  return { rows: kept, older }
}

/** クエリの `recent`（日数）。無い・読めない・0 以下なら絞らない（null） */
export function parseRecent(raw: string | null): number | null {
  const n = Number.parseInt(raw ?? '', 10)
  return Number.isNaN(n) || n <= 0 ? null : n
}
