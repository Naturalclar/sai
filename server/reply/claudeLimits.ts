// SAI から回した Claude の返信（`claude -p`）の出力に載る使用率を `<feed dir>/usage-claude-replies.json` に残す（#694）。
//
// 端末の Claude Code はステータスラインで使用率を渡してくる（`feed/statusline.py` → `usage-claude.json`）が、`-p` は
// ステータスラインを描かない。代わりに stream-json の出力へ API の応答ごとに `rate_limit_event` を出すので、
// reply.log に流れてきたそれを読む。**API は叩かない**（読むのは SAI が起こした子の出力だけ）。
// 形は `usage-claude.json` と同じにして、読む側（`server/local/usage.ts`）は同じ `parseStatusLineUsage()` で読む。
// 派生のファイルなので、消しても次の返信でまた出来る。
import { mkdirSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { lastRateLimitEvent, type RateLimitWindows } from '../../shared/usage.ts'

export const CLAUDE_REPLY_LIMITS_FILE = 'usage-claude-replies.json'

/** 値が変わっていなくても、これだけたったら書き直す（`ts` = 最後に届いた時刻を進める。応答のたびには書かない） */
export const LIMITS_REFRESH_MS = 60_000

/** 返信の出力を渡す先。テストでは差し替える */
export interface ClaudeLimitsSink {
  observe(text: string): void
}

export class ClaudeLimitsFile implements ClaudeLimitsSink {
  readonly path: string
  private readonly now: () => number
  private last: { at: number; key: string } | null = null

  constructor(path: string, now: () => number = Date.now) {
    this.path = path
    this.now = now
  }

  /** 返信の出力の一部を渡す。使用率の知らせが無ければ何もしない。**書けなくても返信は止めない** */
  observe(text: string): void {
    const windows = lastRateLimitEvent(text)
    if (!windows) return
    const at = this.now()
    const key = JSON.stringify(windows)
    if (this.last && this.last.key === key && at - this.last.at < LIMITS_REFRESH_MS) return
    this.last = { at, key }
    try {
      mkdirSync(dirname(this.path), { recursive: true })
      const tmp = `${this.path}.${process.pid}.tmp`
      writeFileSync(tmp, JSON.stringify(limitsRecord(windows, at)))
      renameSync(tmp, this.path)
    } catch {
      // あれば嬉しい程度のもの
    }
  }
}

/** 書き出す中身。`usage-claude.json` と同じ形（`ts` は**届いた時刻**） */
export function limitsRecord(windows: RateLimitWindows, at: number): { v: 1; ts: string; source: 'replies'; rate_limits: RateLimitWindows } {
  return { v: 1, ts: new Date(at).toISOString(), source: 'replies', rate_limits: windows }
}
