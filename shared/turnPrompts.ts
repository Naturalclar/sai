// 「ターン完了の行が、どの入力の行のターンのものか」を辿る状態機械（#626 / #661 / #703）。
// メッセージの返答の引き当て（`shared/agentMessages.ts` の `deliveryMatcher()`）と、記録を調べる道具
// （`server/tools/feedRead.ts` の `pairTurns()`）が同じこの 1 つを使う（規則を片方だけ変えないように）。
import { entityId } from './entity.ts'
import { eventKind } from './events.ts'
import type { FeedRow } from './types.ts'

export interface PromptStep {
  entity: string
  /** ターン完了の行のとき、そのターンの入力した瞬間の行（`UserPromptSubmit`）。覚えていなければ無い */
  prompt?: FeedRow
  /** ターン完了の行か */
  turn: boolean
  /** この行で捨てた入力の行（ターン完了が来ないまま、次の入力・`入力待ち`・セッションの終了が来た） */
  dropped?: FeedRow
}

/**
 * 行を**古い順**に `step()` へ渡す（別のエンティティが混ざっていてよい）。関係のない行（待ち・知らない `event`・
 * 本文の無い合図だけの再開）は null。
 * - 入力した瞬間の行（本文のある `resume`）を覚える。前のが残っていれば捨てる
 * - 覚えた入力の行は、次のターン完了の行 1 つにだけ使う（別のターンに当てない）
 * - **そのターンが終わったと分かる行（`入力待ち`・セッションの終了）が来たら捨てる**（#661 のレビュー）
 *
 * `pending()` は、最後まで残った入力の行（まだターン完了が来ていない）
 */
export function promptTracker(): { step: (row: FeedRow) => PromptStep | null; pending: () => Map<string, FeedRow> } {
  const prompted = new Map<string, FeedRow>()
  return {
    step(row) {
      const kind = eventKind(row.event, row.text)
      if (kind === 'waiting' || kind === 'other') return null
      const entity = entityId(row.session ?? '', row.repo ?? '', String(row.ts ?? ''))
      const before = prompted.get(entity)
      if (kind === 'idle' || kind === 'end') {
        prompted.delete(entity)
        return { entity, turn: false, ...(before ? { dropped: before } : {}) }
      }
      if (kind === 'resume') {
        // 本文の無い合図だけの行（待ちのあとの再開）は、入力の行ではないので前の入力を消さない
        if (!row.user_text?.trim()) return null
        prompted.set(entity, row)
        return { entity, turn: false, ...(before ? { dropped: before } : {}) }
      }
      prompted.delete(entity)
      return { entity, turn: true, ...(before ? { prompt: before } : {}) }
    },
    pending: () => new Map(prompted),
  }
}
