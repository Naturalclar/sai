/**
 * その返答は記録（ターン完了の行）に無く、SAI が transcript から補ったものだという印（#614）。
 * 付けるかはサーバが決める（行の `recovered`。ログイン切れで止まったターンは `recovered_auth_failed`）。フックが間に合わず行が落ちた・本文が空だったターンに付く
 */
export function RecoveredTag({ authFailed = false }: { authFailed?: boolean }) {
  // ログイン切れで止まったターン（#577）。本文は返答ではなく CLI が出した文で、フックが鳴らないので記録の行も無い
  if (authFailed) {
    return (
      <span className="tag recovered auth-failed" title="このターンは Claude のログインが切れて途中で止まりました（下の文は CLI が出したもの。記録の行は無く、transcript から補っています）。ログインし直してから送り直してください">
        ログイン切れで停止
      </span>
    )
  }
  return (
    <span className="tag recovered" title="ターン完了の記録に本文が無かったので、Claude の transcript から補いました（記録の JSONL には書いていません）">
      記録から補った
    </span>
  )
}
