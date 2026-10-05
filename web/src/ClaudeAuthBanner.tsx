import { useState } from 'react'
import { api } from './api'
import { authCheckNote, type AuthCheck } from './claudeAuthNote.ts'

/**
 * Claude のログインが切れているときのバナー（#685）。SAI からはログインしない（読むだけ）ので、直し方を出す。
 * Mac でログインし直したら「確かめ直す」でサーバに聞き直させる（サーバは定期的には聞かない）。
 * ログインできていれば、次のポーリングで一覧の `claude_logged_out` が落ちてバナーごと消える
 */
export function ClaudeAuthBanner() {
  const [check, setCheck] = useState<AuthCheck>({ kind: 'idle' })
  const recheck = () => {
    setCheck({ kind: 'asking' })
    api
      .checkClaudeAuth()
      .then((r) => setCheck({ kind: 'done', loggedIn: r.logged_in }))
      .catch((err: unknown) => setCheck({ kind: 'error', message: err instanceof Error ? err.message : String(err) }))
  }
  const note = authCheckNote(check)
  return (
    <div className="banner auth" role="status">
      Claude のログインが切れています。返信・新しいセッションは失敗します。Mac の端末で <code>claude auth login</code> を打ってください
      <button type="button" className="linkish" disabled={check.kind === 'asking'} onClick={recheck}>
        確かめ直す
      </button>
      {note && <span className="note">{note}</span>}
    </div>
  )
}
