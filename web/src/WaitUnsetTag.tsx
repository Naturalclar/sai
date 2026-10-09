/**
 * 「待ちます」と言って終わったのに、起こす予定が無いセッションの印（#732）。出すかはサーバが決める
 * （`SessionSummary.wait_unset`。返答の末尾の文面と、待ちが預けられていないことから）。置く口はチャットの末尾の `WaitUnsetBar`
 */
export function WaitUnsetTag({ pr }: { pr: number }) {
  return (
    <span className="tag wait-unset" title={`返答の末尾が「待ちます」の類ですが、起こす予定がありません（このままだと、人が見に来るまで止まります）。チャットの末尾から PR #${pr} の CI の待ちを置けます`}>
      待つと言ったが予定なし
    </span>
  )
}
