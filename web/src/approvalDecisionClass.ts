// 許可のバブルの、候補 1 つぶんのボタンの見た目（#741）。判定だけの純粋関数にして node:test で回す。
import type { ApprovalDecision } from '../../shared/types.ts'

/**
 * ボタンのクラス。**押すとこの 1 回を越えて残る候補（`persists`。Codex の規則の追加）は、今回だけのボタンと同じ見た目にしない**:
 * - `allow`: 今回だけの許可（塗り）
 * - `deny`: 今回だけの拒否・中止（枠）
 * - `persist allow`: 「今後聞かない」（枠だけ・許可の色。「許可」と取り違えて押さないように）
 * - `persist deny`: 「今後も断る」（枠だけ・拒否の色。今回だけの「拒否」「ターンを中止」と取り違えないように）
 *
 * SAI 自身の「常に許可」（`always`）とは別のクラスにする（あちらの見た目を変えても巻き込まれないように）
 */
export function decisionClass(decision: Pick<ApprovalDecision, 'behavior' | 'persists'>): string {
  const side = decision.behavior === 'allow' ? 'allow' : 'deny'
  return decision.persists ? `persist ${side}` : side
}
