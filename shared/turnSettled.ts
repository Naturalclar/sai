/**
 * 返信が「行で終わった」と言えるか（#337 / #375）。
 *
 * 送った時刻（`Replying.since`）より後にそのセッションのターン完了の行が届いていれば、そのターンは終わっている。
 * **行の `ts` は秒までしか無い**ので、`since` を秒に丸めてから比べる（同じ秒に届いた行も「後」とみなす。
 * 丸めないと、`16:49:31.200` に送って `16:49:31` に記録された行を「前のターン」と読んでしまう）。
 *
 * 端末に打ち込んだ返信（`TerminalReplies.settle()`）と、答え終わってもプロセスが終わらない CLI
 * （`ProcessRunner.settle()`。実測で `opencode run` が該当）が同じ判定を使う。
 */
export function settledByRow(since: string, lastTurnTs: string | undefined): boolean {
  if (!lastTurnTs) return false
  const from = Math.floor(Date.parse(since) / 1000) * 1000
  const turn = Date.parse(lastTurnTs)
  if (!Number.isFinite(from) || !Number.isFinite(turn)) return false
  return turn >= from
}
