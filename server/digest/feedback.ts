// 一言（digest）への「これは変」を残す（#346）。~/.agent-feed/digest-feedback.jsonl に追記するだけで、
// JSONL（記録）も digest.jsonl も触らない。溜めたものは、規則を直すときの材料と回帰テストの素材にする。
//
// **外には出さない**（SAI は外に出さない）。読むのは人と、手で走らせる物差しのスクリプトだけ。
import { appendFile, mkdir, readFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { isDigestUsageReason } from '../../shared/digestFeedback.ts'
import type { DigestFeedbackReason, DigestUsageReason } from '../../shared/digestFeedback.ts'

export const FEEDBACK_FILE = 'digest-feedback.jsonl'

export interface DigestFeedbackEntry {
  /** 一言と同じ鍵（`<エンティティID>|<行の ts>`）。あとで本文と突き合わせる */
  key: string
  /** そのとき出ていた一言（作り直すと変わるので、言われた時点のものを残す） */
  summary: string
  /** 作った口のモデルと性格（どの組み合わせで出たかを数えられるように） */
  model: string
  persona: string
  /** 「変？」の理由か、使われたかの合図（#446。`opened` / `next_ask_accepted`） */
  reason: DigestFeedbackReason | DigestUsageReason
  /** 受け取った案（`next_ask_accepted` のときだけ。そのとき出ていたもの） */
  next_ask?: string
  /** 「こうしてほしい」（任意）。回帰テストの素材になる */
  note?: string
  ts: string
}

/** digest-feedback.jsonl。「変？」の数だけ覚えておき、中身は溜めるだけ。使われたかの合図（#446）は同じファイルに溜めるが数えない */
export class FeedbackStore {
  readonly path: string
  private count = 0
  private loaded = false

  constructor(path: string) {
    this.path = path
  }

  async load(): Promise<void> {
    if (this.loaded) return
    this.loaded = true
    try {
      for (const line of (await readFile(this.path, 'utf-8')).split('\n')) {
        if (!line.trim()) continue
        let reason: unknown
        try {
          reason = (JSON.parse(line) as { reason?: unknown }).reason
        } catch {
          // 壊れた行も 1 件（前からの数え方のまま）
        }
        if (!isDigestUsageReason(reason)) this.count++
      }
    } catch {
      // 無ければ 0 件
    }
  }

  get size(): number {
    return this.count
  }

  async append(entry: DigestFeedbackEntry): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true })
    await appendFile(this.path, JSON.stringify(entry) + '\n', 'utf-8')
    if (!isDigestUsageReason(entry.reason)) this.count++
  }
}
