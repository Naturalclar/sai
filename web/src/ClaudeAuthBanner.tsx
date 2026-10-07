import { useCallback, useState } from 'react'
import { api } from './api'
import { authCheckNote, type AuthCheck } from './claudeAuthNote.ts'
import { ClaudeLoginPanel } from './ClaudeLoginPanel'
import { loginPanelOpen, rememberLoginPanel } from './claudeLoginOpen.ts'

/** ログインできたら、開いていたことを忘れる（パネルは出したまま。まもなくバナーごと消える） */
const forgetLogin = () => rememberLoginPanel(false, Date.now())

/**
 * Claude のログインが切れているときのバナー（#685）。直し方は 2 つ: 「SAI からログインする」（#577。`ClaudeLoginPanel`。
 * 携帯から tailnet 越しに見ているときも直せる）か、Mac の端末で打つ。
 * Mac でログインし直したら「確かめ直す」でサーバに聞き直させる（サーバは定期的には聞かない）。
 * ログインできていれば、次のポーリングで一覧の `claude_logged_out` が落ちてバナーごと消える
 */
export function ClaudeAuthBanner() {
  const [check, setCheck] = useState<AuthCheck>({ kind: 'idle' })
  // 開いていたことは、このバナーが描き直されても覚えている（`claudeLoginOpen.ts`。絞り込みを変えると一瞬消える）
  // `restored` = 描き直しで開き直した（パネルは状態を聞くだけで、始めない）/ `fresh` = いま人が押した
  const [login, setLogin] = useState<'closed' | 'fresh' | 'restored'>(() => (loginPanelOpen(Date.now()) ? 'restored' : 'closed'))
  const openLogin = (open: boolean) => {
    rememberLoginPanel(open, Date.now())
    setLogin(open ? 'fresh' : 'closed')
  }
  const closeLogin = useCallback(() => {
    rememberLoginPanel(false, Date.now())
    setLogin('closed')
  }, [])
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
      Claude のログインが切れています。返信・新しいセッションは失敗します。ここからログインするか、Mac の端末で <code>claude auth login</code> を打ってください
      {login === 'closed' && (
        <button type="button" className="linkish" onClick={() => openLogin(true)}>
          SAI からログインする
        </button>
      )}
      <button type="button" className="linkish" disabled={check.kind === 'asking'} onClick={recheck}>
        確かめ直す
      </button>
      {note && <span className="note">{note}</span>}
      {login !== 'closed' && <ClaudeLoginPanel resume={login === 'restored'} onClose={closeLogin} onDone={forgetLogin} />}
    </div>
  )
}
