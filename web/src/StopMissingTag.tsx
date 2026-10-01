/**
 * ターンは終わっているのに、ターン完了の行が記録されていないセッションの印（#614）。出すかはサーバが決める
 * （`SessionSummary.stop_missing`。transcript でターンが閉じているのに、記録の最後が人の入力のまま）
 */
export function StopMissingTag() {
  return (
    <span className="tag stop-missing" title="ターンは終わっていますが、ターン完了が記録されていません（フックが間に合わなかった）。最後の返答はここに出ていないので、端末か transcript で確かめてください">
      完了の記録なし
    </span>
  )
}
