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

/** `AGENT_FEED_HOST` を設定していないときの名前 */
export const CLAUDE_REPLY_LIMITS_FILE = 'usage-claude-replies.json'

/** feed dir に置かれる、返信の出力から拾った使用率のファイル（マシンごとに分けたものも） */
export const isReplyLimitsFile = (name: string): boolean => /^usage-claude-replies(\.[^/]+)?\.json$/.test(name)

/**
 * 置くファイルの名前。**`AGENT_FEED_HOST` を設定したときだけ**マシンごとに分ける（`statusline.py` の `usage_file()` と同じ規則。
 * 同期フォルダで複数のマシンのサーバが同じファイルを上書きし合わないように）
 */
export function replyLimitsFile(env: NodeJS.ProcessEnv = process.env): string {
  const host = (env.AGENT_FEED_HOST ?? '').trim().split('.')[0]!.replace(/[^A-Za-z0-9_-]/g, '-')
  return host ? `usage-claude-replies.${host}.json` : CLAUDE_REPLY_LIMITS_FILE
}

/**
 * 書く間隔の下限。知らせは API の応答ごとに来て値もほぼ毎回変わるので、**値に依らず時間で間引く**
 * （サーバのイベントループの上で同期に書くので、並行する返信のぶんだけ書かない）。「届いた時刻」のずれはここまで
 */
export const LIMITS_WRITE_MS = 10_000

/** 返信の出力を渡す先。テストでは差し替える */
export interface ClaudeLimitsSink {
  observe(text: string): void
}

export class ClaudeLimitsFile implements ClaudeLimitsSink {
  readonly path: string
  private readonly now: () => number
  /** 最後に書けた時刻 */
  private wrote = 0

  constructor(path: string, now: () => number = Date.now) {
    this.path = path
    this.now = now
  }

  /** 返信の出力の一部を渡す。使用率の知らせが無ければ何もしない。**書けなくても返信は止めない** */
  observe(text: string): void {
    const at = this.now()
    if (at - this.wrote < LIMITS_WRITE_MS) return
    const windows = lastRateLimitEvent(text)
    if (!windows) return
    try {
      mkdirSync(dirname(this.path), { recursive: true })
      const tmp = `${this.path}.${process.pid}.tmp`
      writeFileSync(tmp, JSON.stringify(limitsRecord(windows, at)))
      renameSync(tmp, this.path)
      // 書けたときだけ覚える（書けなかったら、次の知らせでまた試す）
      this.wrote = at
    } catch {
      // あれば嬉しい程度のもの
    }
  }
}

/** 書き出す中身。`usage-claude.json` と同じ形（`ts` は**届いた時刻**） */
export function limitsRecord(windows: RateLimitWindows, at: number): { v: 1; ts: string; source: 'replies'; rate_limits: RateLimitWindows } {
  return { v: 1, ts: new Date(at).toISOString(), source: 'replies', rate_limits: windows }
}
