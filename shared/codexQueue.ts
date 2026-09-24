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
