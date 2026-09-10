// フィードの返信先から、そのセッションの最後の発言へ飛ぶ（#297）。DOM に依存しないので node:test で回す（feedJump.test.ts）
import type { FeedRow } from '../../shared/types.ts'
import { entityId } from '../../shared/entity.ts'
import { toUtterances } from './chatGroups.ts'

/**
 * 飛び先。`key` はバブル 1 つの `Utterance.key`（`Chat` が `data-key` として DOM に出す）。
 * `seq` は押すたびに増やす。同じバブルへもう一度飛べるように（`Chat` は `seq` が変わったときだけ動く）
 */
export interface FeedJump {
  key: string
  seq: number
}

/**
 * 返信先の「最後の発言」のバブルの `key`。**そのセッションが最後に言ったこと**を見たいので、
 * エージェントの発言（ターン完了・待ち）の一番新しいものを選び、無ければ自分の入力の一番新しいもの。
 * フィードに 1 つも無ければ（日数の窓の外、リポジトリの絞り込み）null。
 *
 * **`ts` ではなく `key` で指す**: フィードは複数のセッションが混ざり `ts` は秒単位なので、同じ秒の別のセッションに
 * 当たりうる。さらに 1 行から自分の入力とエージェントの返答の 2 つのバブルが同じ `ts` で出る。
 * `key` は `Chat` が描くのと同じ `toUtterances()` から取るので、描画されたバブルと必ず 1 対 1 で合う
 */
export function lastUtteranceKey(rows: FeedRow[], id: string): string | null {
  let mine: string | null = null
  const utterances = toUtterances(rows)
  for (let i = utterances.length - 1; i >= 0; i--) {
    const u = utterances[i]!
    if (entityId(u.row.session, u.row.repo, u.row.ts) !== id) continue
    if (u.speaker !== 'me') return u.key
    mine ??= u.key
  }
  return mine
}

/** 飛んだバブルを光らせておく長さ。`.msg.found` の `found-fade`（1s 待って 4s で消える）が終わるまで */
export const JUMP_FLASH_MS = 5_200
