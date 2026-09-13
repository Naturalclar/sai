// 一言（digest）への「これは変」を残す（#346）。~/.agent-feed/digest-feedback.jsonl に追記するだけで、
// JSONL（記録）も digest.jsonl も触らない。溜めたものは、規則を直すときの材料と回帰テストの素材にする。
//
// **外には出さない**（SAI は外に出さない）。読むのは人と、手で走らせる物差しのスクリプトだけ。
import { appendFile, mkdir, readFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { DigestFeedbackReason } from '../../shared/digestFeedback.ts'

export const FEEDBACK_FILE = 'digest-feedback.jsonl'

export interface DigestFeedbackEntry {
  /** 一言と同じ鍵（`<エンティティID>|<行の ts>`）。あとで本文と突き合わせる */
  key: string
  /** そのとき出ていた一言（作り直すと変わるので、言われた時点のものを残す） */
  summary: string
  /** 作った口のモデルと性格（どの組み合わせで出たかを数えられるように） */
  model: string
  persona: string
  reason: DigestFeedbackReason
  /** 「こうしてほしい」（任意）。回帰テストの素材になる */
  note?: string
  ts: string
}

/** digest-feedback.jsonl。数だけ覚えておき（rev に混ぜる）、中身は溜めるだけ */
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
      for (const line of (await readFile(this.path, 'utf-8')).split('\n')) if (line.trim()) this.count++
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
    this.count++
  }
}
