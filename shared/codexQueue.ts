// 開いている Codex の queue（`codex queue`）に渡した返信が、そのスレッドに届いたかを rollout で決める（#474）。
//
// `codex queue` は受け取られたかを返さない（`--help` に状態を返す口が無く、既定の送り先は共有の `unix://` app-server）。
// **受け取り手のいないスレッドに渡しても exit 0 で終わる**: VS Code 拡張・ChatGPT アプリの裏で動く共有の
// `codex app-server --listen` がスレッドの writer lock を握ったまま、どの画面もそのスレッドを開いていないと、
// 本文はターンにならずに消える（実データで queue 36 件中 7 件が rollout に一度も現れなかった）。
//
// 前は「rollout の mtime が送った時刻より新しいか」で見ていたが、それは**何かが書かれたか**であって
// **送った本文が届いたか**ではない。そこで送った本文そのものが、送った時刻より後の rollout に人の入力として
// 現れたかで決める。届いたときは `response_item` の `role: user` / `input_text` として 0.5 秒以内に載る
// （手元の実データ。ターンの始まりまでの遅れは 0〜10 秒だった）。

/**
 * rollout の末尾から読む量。見たいのは「送ってから確かめるまで（30 秒）」の行だけだが、その間に書かれる量は
 * 実データ（人の入力 153 件）で中央値 40KB・99% で 768KB・**最大 2.36MB** あった（大きなツールの出力）。
 * 使用量の読み方の既定（64KB）では届いた返信を「届いていない」と誤って決めるので、最大を覆う 4MB にする
 */
export const QUEUE_ROLLOUT_TAIL_BYTES = 4 * 1024 * 1024

/** 本文の頭から見比べる長さ。全体を一致させる必要は無く、長い本文の改行の揺れに引きずられない */
export const QUEUED_KEY_CHARS = 40
/** since は秒に丸めて持つことがあるので、その分だけ手前も見る */
const SINCE_SKEW_MS = 2_000

const normalize = (text: string): string => text.normalize('NFC').replace(/\s+/g, ' ').trim()

/** 見比べる鍵。空の本文は鍵を作らない（空はどこにでも含まれてしまう） */
export function queuedKey(text: string): string {
  return normalize(text).slice(0, QUEUED_KEY_CHARS)
}

const record = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null

/** rollout の 1 行が人の入力なら、その本文。入力でなければ null */
function inputText(entry: Record<string, unknown>): string | null {
  const payload = record(entry.payload)
  if (!payload) return null
  // 今の形: response_item の message（role: user、content は input_text の並び）
  if (entry.type === 'response_item' && payload.type === 'message' && payload.role === 'user' && Array.isArray(payload.content)) {
    return payload.content.map((block) => (typeof record(block)?.text === 'string' ? (record(block)?.text as string) : '')).join('')
  }
  // 古い形: event_msg の user_message
  if (entry.type === 'event_msg' && payload.type === 'user_message' && typeof payload.message === 'string') return payload.message
  return null
}

/**
 * 送った本文（`text`）が、`sinceMs` より後の rollout の行（`lines`）に人の入力として現れたか。
 * 壊れた行・時刻の無い行は飛ばす（末尾だけ読むと先頭の行は途中で切れている）
 */
export function queuedTextArrived(lines: readonly string[], text: string, sinceMs: number): boolean {
  const key = queuedKey(text)
  if (!key) return false
  for (const line of lines) {
    if (!line.trim()) continue
    let entry: Record<string, unknown> | null
    try {
      entry = record(JSON.parse(line))
    } catch {
      continue
    }
    if (!entry || typeof entry.timestamp !== 'string') continue
    if (!(Date.parse(entry.timestamp) >= sinceMs - SINCE_SKEW_MS)) continue
    const input = inputText(entry)
    if (input !== null && normalize(input).includes(key)) return true
  }
  return false
}

/**
 * ターンが途中だと見なすのをやめるまでの、最後の書き込みからの時間。閉じる印を書かずに止まったターン（端末の Esc など）を
 * いつまでも「回っている」と読まないため（`shared/progress.ts` の `progressActive()` の 10 分と同じ考え方）
 */
export const QUEUE_BUSY_STALE_MS = 10 * 60_000

/** ターンを閉じる印。`turn_aborted` も閉じる（人が止めたターンは `task_complete` を書かない。実データで 8 件） */
const TURN_CLOSED = new Set(['task_complete', 'turn_aborted'])

/**
 * そのスレッドがいまターンの途中か（#474 のレビュー）。**途中なら queue に渡した本文はまだ載っていなくてよい**:
 * 回っているターンが終わってから流れるなら、30 秒で「届いていない」と決めると誤りで、言われたとおり送り直すと
 * 同じ指示が 2 回走る。**実データには「ターン中に queue で送った」回が 1 件も無く、待たされるかは確かめていない**ので、
 * 途中なら判定を保留する側に倒す（すぐ載るならこの保留はほとんど効かない）。
 *
 * 途中とみなすのは、末尾で**最後のターンの印が `task_started`**のとき。末尾に印が 1 つも無い（長いターンで始まりが
 * 読んだ範囲の外に出た）ときも、書き込みが続いていれば途中とみなす。どちらも最後の書き込みが `QUEUE_BUSY_STALE_MS`
 * より古ければ途中とみなさない
 */
export function turnInProgress(lines: readonly string[], nowMs: number): boolean {
  let last: 'open' | 'closed' | null = null
  let latest = Number.NaN
  for (const line of lines) {
    if (!line.trim()) continue
    let entry: Record<string, unknown> | null
    try {
      entry = record(JSON.parse(line))
    } catch {
      continue
    }
    if (!entry) continue
    const at = typeof entry.timestamp === 'string' ? Date.parse(entry.timestamp) : Number.NaN
    if (!Number.isNaN(at)) latest = at
    if (entry.type !== 'event_msg') continue
    const kind = record(entry.payload)?.type
    if (kind === 'task_started') last = 'open'
    else if (typeof kind === 'string' && TURN_CLOSED.has(kind)) last = 'closed'
  }
  if (Number.isNaN(latest) || nowMs - latest > QUEUE_BUSY_STALE_MS) return false
  return last !== 'closed'
}
