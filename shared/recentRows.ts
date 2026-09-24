// セッション画面で描く行を直近に絞る（#477）。
//
// 行の多いセッション（手元で 1045 行・本文 43 万字、DOM 2.3 万要素）は、3 秒のポーリングのたびにチャット全体を
// 描き直すので、遅い端末では打鍵が 150ms 止まる。そこで詳細の API は既定で**直近 `RECENT_DAYS` 日の行だけ**を返し、
// それより前は画面の「前の 7 日を表示」で必要なときに取る。日数は一番新しい行から数える。同じセッションで 7 日より前を見る回は少なく、
// 手元の一番大きいセッションは 1045 行 → 176 行になる。

/** セッション画面が最初に描く日数。押すたびにこの日数ずつさかのぼる */
export const RECENT_DAYS = 7

const DAY_MS = 24 * 60 * 60 * 1000

/**
 * 一番新しい行から `recentDays` 日さかのぼった行と、それより前で落とした行の数。
 * **起点は「いま」ではなくそのセッションの一番新しい行**（しばらく触っていないセッションを開いたら空、にしない。
 * 7 日以上前に許可待ちで止まったセッションの待ちのバブルも、最後の行なので残る）。
 * `focusTs`（検索の飛び先）があれば、その行まで必ず含める（落とすと飛べない）。
 * 時刻の読めない行は落とさない（どちら側か分からないものを消さない）
 */
export function recentRows<T extends { ts?: string }>(rows: readonly T[], recentDays: number, focusTs = ''): { rows: T[]; older: number; dropped: T[] } {
  let latest = Number.NaN
  for (const row of rows) {
    const at = Date.parse(row.ts ?? '')
    if (!Number.isNaN(at) && !(at <= latest)) latest = at
  }
  if (Number.isNaN(latest)) return { rows: [...rows], older: 0, dropped: [] }
  let cutoff = latest - recentDays * DAY_MS
  const focus = Date.parse(focusTs)
  if (!Number.isNaN(focus)) cutoff = Math.min(cutoff, focus)
  const kept: T[] = []
  const dropped: T[] = []
  for (const row of rows) {
    const at = Date.parse(row.ts ?? '')
    if (!Number.isNaN(at) && at < cutoff) dropped.push(row)
    else kept.push(row)
  }
  return { rows: kept, older: dropped.length, dropped }
}

/** 落とした行から ↑ の履歴に足す入力の数の上限（3 秒ごとに運ぶので、全部は載せない） */
export const OLDER_PROMPTS_MAX = 50

/**
 * 落とした行の人の入力を、新しい順に（連続する同じ文は畳む）。描かない行の入力も ↑ で呼び戻せるように、
 * 詳細の応答の `older_prompts` に載せる（#477 のレビュー。画面の履歴は描いている行から作るので、無いと 7 日より前が消える）
 */
export function olderPrompts(dropped: readonly { user_text?: string }[], max = OLDER_PROMPTS_MAX): string[] {
  const out: string[] = []
  for (let i = dropped.length - 1; i >= 0 && out.length < max; i--) {
    const text = (dropped[i]!.user_text ?? '').trim()
    if (text && text !== out[out.length - 1]) out.push(text)
  }
  return out
}

/** クエリの `recent`（日数）。無い・読めない・0 以下なら絞らない（null） */
export function parseRecent(raw: string | null): number | null {
  const n = Number.parseInt(raw ?? '', 10)
  return Number.isNaN(n) || n <= 0 ? null : n
}
