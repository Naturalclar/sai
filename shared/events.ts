// 1行の `event` の読み方。行は「ターン完了」だけでなく「待ち始めた」「人が答えて再開した」も来る。
// 出どころは feed/record.py（Claude Code のフック名がそのまま `event` に載る）。
// サーバの集計（turns / waiting）と画面の描き分け（待ちバブル）が同じ判定を使う。

export type EventKind = 'turn' | 'waiting' | 'resume'

/**
 * - `turn`: ターン完了。`Stop`（Claude）/ `agent-turn-complete`（Codex）。古い行の `unknown` もここ
 * - `waiting`: 人を待って止まった。`PermissionRequest`（許可）/ `PreToolUse`（AskUserQuestion / ExitPlanMode）/ `Notification`（入力待ちなど）
 * - `resume`: 人が答えて再開した。`UserPromptSubmit`。待ちの解消の合図で、本文は無い
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
