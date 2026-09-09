// 「要対応」（#224）に並べるものを組み立てる。DOM に依存しないので todoItems.test.ts を node:test で回す。
import { replyBlockedReason } from '../../shared/reply.ts'
import type { Approval, ApprovalMap, ReplyingMap, SessionSummary } from '../../shared/types.ts'

/**
 * - `answer`: エージェントが答えを待っていて、SAI がその口を持っている。**この画面から答えられる**
 * - `watch`: 記録の行から見た待ち（`SessionSummary.waiting`）。SAI に選択肢が届いていないので
 *   ボタンは出せないが、**返信欄からは打てることが多い**（`replyable`）
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
  /**
   * `watch` のとき、SAI の返信欄からその会話に打ち込めるか（#232）。
   * 打てるなら「開いて返信欄から答えられます」、打てないなら「端末で答えてください」を出す。
   * **「SAI からは答えられない」と決めつけない**（端末で開いていれば打ち込めるし、再開もできる）
   */
  replyable: boolean
}

/**
 * 待たせている順（古い順）。同時刻は ID で決めて、ポーリングのたびに並びが揺れないようにする。
 *
 * **`answer` は絞り込みに関わらず全部出す。** `/api/sessions` の `approvals` は
 * `Approvals.snapshot()` そのもので、リポジトリや日数の絞り込みを通っていない（サーバ側で確認）。
 * ここはエージェントを止めている＝取りこぼすと困るものなので、一覧から消えていても出す
 * （その場合 `session` が null になり、画面は ID を出すだけになる）。
 * 逆に `watch` は `SessionSummary.waiting` からしか作れないので、**絞り込みには従う**。
 *
 * **別プロセスの返信を処理中のセッションは `watch` を出さない**（#232）。`claude -p` の許可・質問は
 * 必ず `--permission-prompt-tool` を通るので、答え待ちがあれば上の `answer` に載っている。
 * 載っていなければ「答えを待っている」のではなく「動いている」。行の `waiting` は
 * **待ちの行より後にターン完了の行が届くまで消えない**ので、答えたあとも残ってしまう
 * （許可や質問への回答は `UserPromptSubmit` ではないため `record.py` は再開の行を書かない）。
 * 端末に打ち込んだ返信（`via: 'terminal'`）は SAI に口が無く、行の `waiting` だけが手がかりなので**残す**。
 */
export function todoItems(sessions: readonly SessionSummary[], approvals: ApprovalMap, replying: ReplyingMap = {}): TodoItem[] {
  const byId = new Map(sessions.map((s) => [s.id, s]))
  const out: TodoItem[] = []
  for (const [id, list] of Object.entries(approvals)) {
    const first = list?.[0]
    if (!first) continue
    out.push({ id, kind: 'answer', text: first.text, since: first.since, session: byId.get(id) ?? null, approval: first, replyable: false })
  }
  const answering = new Set(out.map((t) => t.id))
  for (const s of sessions) {
    // 答え待ちが出ているセッションは上で入れてある（そちらの方が新しくて具体的）
    if (!s.waiting || answering.has(s.id) || s.archived) continue
    if (processReplying(replying[s.id])) continue
    out.push({ id: s.id, kind: 'watch', text: s.waiting, since: s.end, session: s, approval: null, replyable: replyBlockedReason(s) === '' })
  }
  return out.sort((a, b) => (a.since === b.since ? a.id.localeCompare(b.id) : a.since < b.since ? -1 : 1))
}

/** 別プロセス（`-p` / `exec resume`）の返信が動いている。失敗して残っている分は「動いている」ではない */
function processReplying(r: ReplyingMap[string] | undefined): boolean {
  return Boolean(r) && r!.via !== 'terminal' && !r!.failed
}
