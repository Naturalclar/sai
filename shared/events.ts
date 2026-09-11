// 1行の `event` の読み方。行は「ターン完了」だけでなく「待ち始めた」「人が入力した」も来る。
// 出どころは feed/record.py（Claude Code のフック名がそのまま `event` に載る）。
// サーバの集計（turns / waiting）と画面の描き分け（待ちバブル）が同じ判定を使う。

export type EventKind = 'turn' | 'waiting' | 'resume' | 'other'

/**
 * - `turn`: ターン完了。`Stop`（Claude）/ `agent-turn-complete`（Codex）/ `session.idle`（OpenCode）。`unknown` と空もここ
 * - `waiting`: 人を待って止まった。`PermissionRequest`（許可）/ `PreToolUse`（AskUserQuestion / ExitPlanMode）/ `Notification`（入力待ちなど）/ `permission.asked`（OpenCode）
 * - `resume`: 人が入力した。`UserPromptSubmit` / `permission.replied`（OpenCode。答えて動き出した）。`user_text` にその入力が載り（本文 `text` は無い）、直前が待ちならその解消の合図でもある。
 *   古い行は `user_text` も無い（合図だけ）
 * - `other`: 知らない event。**数えないし出さない**
 *
 * **turn は名指しで、知らない値は `other` に落とす**（#235）。以前は既定が `turn` だったので、
 * `record.py` が書いた知らない event の行（Claude の `SubagentStop` / `PreCompact`、Codex の
 * `session-configured` など。record.py は notify の type やフック名をそのまま載せる）が
 * 「一番新しいターン完了」の座を奪い、本文の無い行で一覧の「最後の発言」が空になり、
 * `last_turn_ts` がずれて一言（digest）が消え、`turns` も水増しされていた。
 *
 * `unknown` は **`record.py` の `detect_event()` が `hook_event_name` も `type` も無いペイロードに
 * 対して今も返す値**なので（古い行だけの話ではない）、turn として名指しで残す。
 *
 * OpenCode の名前は SAI のプラグイン（feed/opencode/）が載せる。名前は OpenCode のイベント名そのまま（#209）
 *
 * Grok Build（#325）は Claude と同じ名前（`Stop` / `UserPromptSubmit` / `Notification`）で載る
 * （フックの payload の `hook_event_name` が Claude 向けの PascalCase の名前。record.py がそれを使う）
 */
export function eventKind(event: string | undefined): EventKind {
  switch (event) {
    case 'Stop':
    case 'agent-turn-complete':
    case 'session.idle':
    case 'unknown':
    case '':
    case undefined:
      return 'turn'
    case 'PermissionRequest':
    case 'PreToolUse':
    case 'Notification':
    case 'permission.asked':
      return 'waiting'
    case 'UserPromptSubmit':
    case 'permission.replied':
      return 'resume'
    default:
      return 'other'
  }
}
