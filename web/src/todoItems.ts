// 「要対応」（#224）に並べるものを組み立てる。DOM に依存しないので todoItems.test.ts を node:test で回す。
import type { Approval, ApprovalMap, SessionSummary } from '../../shared/types.ts'

/**
 * - `answer`: SAI が返信を回していて、その中のエージェントが答えを待っている。**この画面から答えられる**
 * - `watch`: 記録の行から見た待ち（`SessionSummary.waiting`）。端末で止まっているので、
 *   ここからは答えられない（端末に行くか、返信として打ち込む）
 */
export type TodoKind = 'answer' | 'watch'

export interface TodoItem {
  /** エンティティID */
  id: string
  kind: TodoKind
  /** 何を待っているか（1行） */
  text: string
  /** いつから待っているか。並べ替えの基準 */
  since: string
  /** 一覧に居れば。**絞り込みで隠れている `answer` では null になる**（後述） */
  session: SessionSummary | null
  /** kind === 'answer' のときだけ。そのまま ApprovalBubble に渡す */
  approval: Approval | null
}

/**
 * 待たせている順（古い順）。同時刻は ID で決めて、ポーリングのたびに並びが揺れないようにする。
 *
 * **`answer` は絞り込みに関わらず全部出す。** `/api/sessions` の `approvals` は
 * `Approvals.snapshot()` そのもので、リポジトリや日数の絞り込みを通っていない（サーバ側で確認）。
 * ここはエージェントを止めている＝取りこぼすと困るものなので、一覧から消えていても出す
 * （その場合 `session` が null になり、画面は ID を出すだけになる）。
 * 逆に `watch` は `SessionSummary.waiting` からしか作れないので、**絞り込みには従う**。
 */
export function todoItems(sessions: readonly SessionSummary[], approvals: ApprovalMap): TodoItem[] {
  const byId = new Map(sessions.map((s) => [s.id, s]))
  const out: TodoItem[] = []
  for (const [id, list] of Object.entries(approvals)) {
    const first = list?.[0]
    if (!first) continue
    out.push({ id, kind: 'answer', text: first.text, since: first.since, session: byId.get(id) ?? null, approval: first })
  }
  const answering = new Set(out.map((t) => t.id))
  for (const s of sessions) {
    // 答え待ちが出ているセッションは上で入れてある（そちらの方が新しくて具体的）
    if (!s.waiting || answering.has(s.id) || s.archived) continue
    out.push({ id: s.id, kind: 'watch', text: s.waiting, since: s.end, session: s, approval: null })
  }
  return out.sort((a, b) => (a.since === b.since ? a.id.localeCompare(b.id) : a.since < b.since ? -1 : 1))
}
