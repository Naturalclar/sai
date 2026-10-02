// 自動の要約（compact）の文が、人の入力として記録された行を見分ける（#626）。
// 記録の側（`feed/record.py`）は transcript の印（`isCompactSummary`）で飛ばすようになったが、**もう書かれた行には印が無い**
// （`user_text` に要約の文だけが残っている）ので、読む側は文の書き出しで見る。記録は書き換えない。
// 画面の自分のバブル・題名と `last_user_text`・↑ の履歴・メッセージの返答の引き当てが同じこの 1 つを見る。

/** Claude Code が要約の頭に置く決まり文句（`/compact` でも自動でも同じ） */
export const COMPACT_SUMMARY_HEAD = 'This session is being continued from a previous conversation'

/** その `user_text` は人が打った文ではなく、要約の文か */
export function isCompactSummaryText(userText: string | undefined): boolean {
  return (userText ?? '').trimStart().startsWith(COMPACT_SUMMARY_HEAD)
}
