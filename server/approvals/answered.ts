// 画面から答えた許可・質問を、ターンが終わるまで覚えておく（#693）。
//
// 許可のバブルは「いま待っているもの」から毎回作るので、答えると消えるだけだった。Claude はフックの待ちの行が記録に残るが、
// Codex にはフックが無く（notify はターン完了だけ）、答えたあとターンが終わるまで画面に何も出なかった。
// **メモリだけ**（JSONL にも state にも書かない。立て直すと忘れる）。覚えるのは画面に出していた 1 行（`Approval.text`）と
// 答えの向きだけで、入力そのもの（コマンドの全文・ファイルの中身）は持たない。
import type { AnsweredApproval, Approval, SessionProgressResponse } from '../../shared/types.ts'

/** 1 つのセッションで覚えておく件数。超えたら古い方から捨てる */
export const ANSWERED_MAX = 20
/** 覚えておく長さ。ターンがこれより長く続くことは稀で、ターン完了の行が落ちたときに残り続けないための上限 */
export const ANSWERED_TTL_MS = 6 * 60 * 60_000

/**
 * 「ここより前に答えたものは、もう終わったターンのもの」の時刻（#695 のレビュー）。次のうち一番新しいもの:
 *
 * - 最後のターン完了の行。**行の `ts` は秒まで**なので、その秒の終わりまで（同じ秒に答えたものは、そのターンのもの）
 * - transcript / rollout の上で最後のターンが閉じた時刻（Claude の `closed_at`、Codex の `turn_closed`）。
 *   **止めた・中断したターンはターン完了の行が来ない**ので、行だけ見ていると答えた許可が残り続け、次のターンの「処理中」の上に出る
 * - Codex の開いているターンの始まり（`turn_since`）。それより前に答えたものは前のターンのもの
 *
 * 読めなければ（progress が無い・時刻が読めない）行だけで決める
 */
export function answeredAfter(lastTurnTs: string, progress?: Pick<SessionProgressResponse, 'turn_since' | 'turn_closed' | 'closed_at'> | null): string {
  const row = Date.parse(lastTurnTs)
  const times = [Number.isNaN(row) ? NaN : Math.floor(row / 1000) * 1000 + 999, Date.parse(progress?.closed_at ?? ''), Date.parse(progress?.turn_closed ?? ''), Date.parse(progress?.turn_since ?? '')].filter((t) => !Number.isNaN(t))
  return times.length > 0 ? new Date(Math.max(...times)).toISOString() : ''
}

export class AnsweredApprovals {
  private readonly bySession = new Map<string, AnsweredApproval[]>()
  private readonly now: () => number

  constructor(now: () => number = Date.now) {
    this.now = now
  }

  /** 答えが通ったあとに呼ぶ。`label` は押した選択肢の文言（あれば） */
  add(approval: Pick<Approval, 'approval_id' | 'id' | 'text'>, behavior: 'allow' | 'deny', label = ''): void {
    const list = (this.bySession.get(approval.id) ?? []).filter((a) => a.approval_id !== approval.approval_id)
    list.push({ approval_id: approval.approval_id, text: approval.text, behavior, at: new Date(this.now()).toISOString(), ...(label ? { label } : {}) })
    this.bySession.set(approval.id, list.slice(-ANSWERED_MAX))
  }

  /**
   * そのセッションで答えたもののうち、**`after`（最後のターン完了の時刻）より後**のもの（古い順）。
   * ターンが終わったら出さない（終わったターンの手順は #605 の「手順」から見られる）。古すぎるものは捨てる
   */
  of(id: string, after = ''): AnsweredApproval[] {
    const list = this.bySession.get(id)
    if (!list) return []
    const oldest = this.now() - ANSWERED_TTL_MS
    const afterMs = after ? Date.parse(after) : NaN
    const kept = list.filter((a) => Date.parse(a.at) >= oldest && !(Date.parse(a.at) <= afterMs))
    if (kept.length === 0) this.bySession.delete(id)
    else if (kept.length !== list.length) this.bySession.set(id, kept)
    return kept
  }
}
