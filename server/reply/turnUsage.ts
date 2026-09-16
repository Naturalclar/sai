// SAI が起こしたターンの使用量を `<feed dir>/turn-usage.jsonl` に追記し、読み返して行に載せる（#387 / #411）。
//
// **記録（`YYYY-MM-DD.jsonl`）は触らない**。フックが書くものだけ、を崩さないため、digest.jsonl と同じく
// 派生データの別ファイルにする（消しても履歴は壊れない）。中身の作り方は shared/turnUsage.ts。
import { appendFile, mkdir, readFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { digestKey } from '../../shared/digestFeedback.ts'
import { usageByRow } from '../../shared/turnUsage.ts'
import type { TurnUsage, TurnUsageEntry } from '../../shared/turnUsage.ts'
import type { FeedRow } from '../../shared/types.ts'

export const TURN_USAGE_FILE = 'turn-usage.jsonl'

/**
 * 起動時に読み返す窓（日）。**ファイルは切り詰めない**（digest.jsonl と同じく追記だけ。消しても壊れない）が、
 * 画面が出すのは一覧の窓（最大 90 日）の行なので、それより古いぶんはメモリに持たない
 */
export const TURN_USAGE_KEEP_DAYS = 90

export type { TurnUsageEntry }

/** 使用量の行き先。テストでは差し替える（本物はファイルに追記する） */
export interface TurnUsageSink {
  record(id: string, usage: TurnUsage): void
}

/**
 * turn-usage.jsonl への追記と読み返し。**書けなくても返信は止めない**（あれば嬉しい程度のもの）。
 *
 * 書くのは `ProcessRunner`（ターンが終わったとき）、読むのは `/api/feed` と詳細の応答。**同じ 1 つを両方に渡す**ので、
 * 追記した分はそのままメモリにも載り、応答のたびにファイルを読み直さない（3 秒のポーリングを重くしない）
 */
export class TurnUsageLog implements TurnUsageSink {
  readonly path: string
  /** 直前の追記。**順に書く**（投げっぱなしのまま並べると、2 件が同時に来たとき行の順が入れ替わる） */
  private last: Promise<void> = Promise.resolve()
  private entries: TurnUsageEntry[] = []
  private loaded = false
  private revValue = ''

  constructor(path: string) {
    this.path = path
  }

  /** 起動時に 1 回。無ければ空のまま（返信を 1 度も回していないマシンでは、そもそもファイルが無い） */
  async load(): Promise<void> {
    if (this.loaded) return
    this.loaded = true
    const since = Date.now() - TURN_USAGE_KEEP_DAYS * 24 * 60 * 60_000
    try {
      for (const line of (await readFile(this.path, 'utf-8')).split('\n')) {
        const t = line.trim()
        if (!t) continue
        try {
          const e = JSON.parse(t) as TurnUsageEntry
          if (!e || typeof e.ts !== 'string' || typeof e.id !== 'string') continue
          const at = Date.parse(e.ts)
          if (Number.isNaN(at) || at < since) continue
          this.entries.push(e)
        } catch {
          // 壊れた行は落とす
        }
      }
    } catch {
      // 無ければ空
    }
    this.bumpRev()
  }

  record(id: string, usage: TurnUsage): void {
    const entry: TurnUsageEntry = { ts: new Date().toISOString(), id, ...usage }
    this.entries.push(entry)
    this.bumpRev()
    this.last = this.last.then(() => this.append(entry))
  }

  /** 行に `usage` を載せる。当たらない行はそのまま（コピーしない）。当てる規則は `usageByRow()`（#411） */
  attach(rows: FeedRow[]): FeedRow[] {
    if (this.entries.length === 0) return rows
    const byRow = usageByRow(rows, this.entries)
    if (byRow.size === 0) return rows
    return rows.map((r) => {
      const e = byRow.get(digestKey(r))
      if (!e) return r
      const { ts: _ts, id: _id, ...usage } = e
      return { ...r, usage }
    })
  }

  /** 覚えている行の数（読み返しの窓の中だけ） */
  get size(): number {
    return this.entries.length
  }

  /** 中身が変わったかの識別子。rev に混ぜる（行より 1〜2 秒遅れて届くので、混ぜないと次の行まで画面に出ない） */
  rev(): string {
    return this.revValue
  }

  private bumpRev(): void {
    this.revValue = `${this.entries.length}:${this.entries[this.entries.length - 1]?.ts ?? ''}`
  }

  private async append(entry: TurnUsageEntry): Promise<void> {
    try {
      await mkdir(dirname(this.path), { recursive: true })
      await appendFile(this.path, JSON.stringify(entry) + '\n', 'utf-8')
    } catch {
      // 書けなくても実害なし（この行が残らないだけ）
    }
  }
}
