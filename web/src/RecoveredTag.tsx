/**
 * その返答は記録（ターン完了の行）に無く、SAI が transcript から補ったものだという印（#614）。
 * 付けるかはサーバが決める（行の `recovered`）。フックが間に合わず行が落ちた・本文が空だったターンに付く
 */
export function RecoveredTag() {
  return (
    <span className="tag recovered" title="ターン完了の記録に本文が無かったので、Claude の transcript から補いました（記録の JSONL には書いていません）">
      記録から補った
    </span>
  )
}
