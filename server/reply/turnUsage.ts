// SAI が起こしたターンの使用量を `<feed dir>/turn-usage.jsonl` に追記する（#387）。
//
// **記録（`YYYY-MM-DD.jsonl`）は触らない**。フックが書くものだけ、を崩さないため、digest.jsonl と同じく
// 派生データの別ファイルにする（消しても履歴は壊れない）。中身の作り方は shared/turnUsage.ts。
import { appendFile, mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { TurnUsage } from '../../shared/turnUsage.ts'

export const TURN_USAGE_FILE = 'turn-usage.jsonl'

/** 1 行。`id` はエンティティ ID、`ts` は書いた時刻（ターンが終わった時刻） */
export interface TurnUsageEntry extends TurnUsage {
  ts: string
  id: string
}

/** 使用量の行き先。テストでは差し替える（本物はファイルに追記する） */
export interface TurnUsageSink {
  record(id: string, usage: TurnUsage): void
}

/** turn-usage.jsonl への追記。**書けなくても返信は止めない**（あれば嬉しい程度のもの） */
export class TurnUsageLog implements TurnUsageSink {
  readonly path: string
  /** 直前の追記。**順に書く**（投げっぱなしのまま並べると、2 件が同時に来たとき行の順が入れ替わる） */
  private last: Promise<void> = Promise.resolve()

  constructor(path: string) {
    this.path = path
  }

  record(id: string, usage: TurnUsage): void {
    this.last = this.last.then(() => this.append(id, usage))
  }

  private async append(id: string, usage: TurnUsage): Promise<void> {
    const entry: TurnUsageEntry = { ts: new Date().toISOString(), id, ...usage }
    try {
      await mkdir(dirname(this.path), { recursive: true })
      await appendFile(this.path, JSON.stringify(entry) + '\n', 'utf-8')
    } catch {
      // 書けなくても実害なし（この行が残らないだけ）
    }
  }
}
