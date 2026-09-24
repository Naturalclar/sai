// 1行の `event` の読み方。行は「ターン完了」だけでなく「待ち始めた」「人が入力した」も来る。
// 出どころは feed/record.py（Claude Code のフック名がそのまま `event` に載る）。
// サーバの集計（turns / waiting / idle）と画面の描き分け（待ちバブル）が同じ判定を使う。

/** `record.py` が `idle_prompt` / `agent_needs_input` に付ける見出し（`_WAITING_NOTIFICATIONS`） */
export const IDLE_PREFIX = '入力待ち'

export type EventKind = 'turn' | 'waiting' | 'idle' | 'resume' | 'end' | 'other'

/**
 * - `turn`: ターン完了。`Stop`（Claude）/ `agent-turn-complete`（Codex）/ `session.idle`（OpenCode）。`unknown` と空もここ
 * - `waiting`: 人を待って止まった。`PermissionRequest`（許可）/ `PreToolUse`（AskUserQuestion / ExitPlanMode）/ `Notification`（許可待ち・MCP の入力待ちなど）/ `permission.asked`（OpenCode）
 * - `idle`: **ターンが終わって放置されているだけ**（#438）。Claude の `Notification` の `idle_prompt`（ターン完了の 60 秒後）と
 *   `agent_needs_input`。詰まっているわけではないので「要対応」でも通知でも `waiting` と同じ重さにしない
 * - `resume`: 人が入力した。`UserPromptSubmit` / `permission.replied`（OpenCode。答えて動き出した）。`user_text` にその入力が載り（本文 `text` は無い）、直前が待ちならその解消の合図でもある。
 *   古い行は `user_text` も無い（合図だけ）
 * - `end`: セッションが終わった（`SessionEnd`。Claude だけ。#385）。`text` は「なぜ終わったか」で、
 *   **`/clear` はここより前をエージェントが覚えていない**という区切りでもある（`record.py` は人が意図して
 *   終えたものだけ書く。`-p` の 1 回とペインごとの kill はどちらも `reason: other` で区別が付かないので書かない）
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
 *
 * **`text` は省略できない**（#438）。`Notification` は「詰まっている（許可待ち）」と「終わって放置されている
 * （入力待ち）」の両方で鳴るので、`event` だけでは分けられない。既定値を持たせると、渡し忘れた呼び出しが
 * 黙って「全部 `waiting`」に戻る（`replyBlockedReason()` の第 2 引数と同じ理由）
 */
export function eventKind(event: string | undefined, text: string | undefined): EventKind {
  if (event === 'Notification' && isIdleText(text)) return 'idle'
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
    case 'SessionEnd':
      return 'end'
    default:
      return 'other'
  }
}

/**
 * 「終わって放置されているだけ」の待ちの行か。判定は `text` の**接頭辞**で、`record.py` の
 * `_WAITING_NOTIFICATIONS` と揃えてある（`idle_prompt` → `入力待ち`、`agent_needs_input` →
 * `入力待ち（バックグラウンドのセッション）`）。**行の形は変えない**ので `RECORD_VERSION` も上げない。
 *
 * `elicitation_dialog` の `MCP サーバーの入力待ち` は「入力待ち」を**含む**が**始まらない**ので
 * 今までどおり `waiting`（あちらは答えないと進まない）。`許可待ち: …` も同じ
 */
function isIdleText(text: string | undefined): boolean {
  return (text ?? '').startsWith(IDLE_PREFIX)
}
