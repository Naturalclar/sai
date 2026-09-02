// 1行の `event` の読み方。行は「ターン完了」だけでなく「待ち始めた」「人が入力した」も来る。
// 出どころは feed/record.py（Claude Code のフック名がそのまま `event` に載る）。
// サーバの集計（turns / waiting）と画面の描き分け（待ちバブル）が同じ判定を使う。

export type EventKind = 'turn' | 'waiting' | 'resume'

/**
 * - `turn`: ターン完了。`Stop`（Claude）/ `agent-turn-complete`（Codex）。古い行の `unknown` もここ
 * - `waiting`: 人を待って止まった。`PermissionRequest`（許可）/ `PreToolUse`（AskUserQuestion / ExitPlanMode）/ `Notification`（入力待ちなど）
 * - `resume`: 人が入力した。`UserPromptSubmit`。`user_text` にその入力が載り（本文 `text` は無い）、直前が待ちならその解消の合図でもある。
 *   古い行は `user_text` も無い（合図だけ）
 */
export function eventKind(event: string | undefined): EventKind {
  switch (event) {
    case 'PermissionRequest':
    case 'PreToolUse':
    case 'Notification':
      return 'waiting'
    case 'UserPromptSubmit':
      return 'resume'
    default:
      return 'turn'
  }
}
