/**
 * ターンは終わっているのに、ターン完了の行が記録されていないセッションの印（#614）。出すかはサーバが決める
 * （`SessionSummary.stop_missing`。transcript でターンが閉じているのに、記録の最後が人の入力のまま）。
 * 返答を transcript から補えたときは出ない（そのバブルに「記録から補った」が付く）
 */
export function StopMissingTag() {
  return (
    <span className="tag stop-missing" title="ターンは終わっていますが、ターン完了が記録されておらず、返答も transcript から補えませんでした（フックが間に合わなかった）。端末か transcript で確かめてください">
      完了の記録なし
    </span>
  )
}
