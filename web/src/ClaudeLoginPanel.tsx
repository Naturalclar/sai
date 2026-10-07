import { useEffect, useRef, useState } from 'react'
import type { ClaudeLoginRequest, ClaudeLoginResponse } from '../../shared/types.ts'
import { api } from './api'
import { LOGIN_LOST_NOTE, loginAcceptsCode, loginActive, loginNote } from './claudeLoginNote.ts'

/**
 * SAI から Claude にログインし直す手順（#577）。バナーの「SAI からログインする」で開く。
 * サーバが `claude auth login` を起こして出したログイン用の URL を、**人が自分の端末のブラウザ**（携帯でもよい）で開き、
 * そのページに出たコードをここに貼る。SAI は URL もコードも残さない（コードは送ったら欄から消す）。Mac のブラウザは開かない。
 *
 * **手順を持っているのはサーバ**で、ここは映すだけ。人が押して開いたときだけ「始める」を送る（もう進んでいれば同じ手順の続きが返る）。
 * バナーが描き直されて開き直したとき（`resume`）は**状態を聞くだけで、始めない**（人が押していないのに子を起こさない）。
 * **子を落とすのは「やめる」を押したときだけ**（描き直しや別のタブを閉じたことで、進んでいるログインを落とさない）。
 * 放っておいた子はサーバが時間切れで落とす
 */
export function ClaudeLoginPanel({ resume, onClose, onDone }: { resume: boolean; onClose: () => void; onDone: () => void }) {
  const [state, setState] = useState<ClaudeLoginResponse>({ status: 'starting' })
  const [code, setCode] = useState('')
  const [error, setError] = useState('')
  // 始める POST が返るまでは状態を聞かない（前の回の「時間切れ」「できた」を、いまの回のものとして出さない）
  const [started, setStarted] = useState(false)
  // 進んでいた手順が、この画面の外で止まった（別の画面でやめた・サーバを立て直した）
  const [lost, setLost] = useState(false)
  // 応答の順番。操作（POST）より前に出した問い合わせ（GET）の応答で、新しい状態を上書きしない
  const seq = useRef(0)

  useEffect(() => {
    let alive = true
    const mine = ++seq.current
    const first = resume ? api.claudeLoginState() : api.claudeLogin({ action: 'start' })
    first
      .then((s) => {
        if (!alive || mine !== seq.current) return
        // 開き直したのに、もう何も進んでいない: 黙って閉じる（始め直さない）
        if (resume && (s.status === 'idle' || s.status === 'done')) return onClose()
        setState(s)
      })
      .catch((err: unknown) => {
        if (!alive || mine !== seq.current) return
        setState({ status: 'idle' })
        setError(err instanceof Error ? err.message : String(err))
      })
      .finally(() => alive && setStarted(true))
    return () => {
      alive = false
    }
  }, [resume, onClose])
  // 走っている間だけ 2 秒ごとに状態を聞く（一覧の 3 秒のポーリングには載せない）
  const active = started && loginActive(state)
  useEffect(() => {
    if (!active) return
    let alive = true
    const timer = setInterval(() => {
      const mine = seq.current
      api
        .claudeLoginState()
        .then((s) => {
          if (!alive || mine !== seq.current) return
          if (s.status === 'idle') setLost(true)
          setState(s)
        })
        .catch(() => {})
    }, 2000)
    return () => {
      alive = false
      clearInterval(timer)
    }
  }, [active])
  // ログインできたら、開いていたことを忘れる（次に切れたとき勝手に始めない）
  const done = state.status === 'done'
  useEffect(() => {
    if (done) onDone()
  }, [done, onDone])

  const act = (body: ClaudeLoginRequest) => {
    const mine = ++seq.current
    setError('')
    setLost(false)
    api
      .claudeLogin(body)
      .then((s) => mine === seq.current && setState(s))
      .catch((err: unknown) => mine === seq.current && setError(err instanceof Error ? err.message : String(err)))
  }
  const send = () => {
    const text = code.trim()
    if (!text) return
    // 送ったら欄から消す（画面にも残さない）
    setCode('')
    act({ action: 'code', code: text })
  }
  const close = () => {
    // 「やめる」は進んでいる手順を落とす。終わった・失敗したあとの「閉じる」は何も送らない
    if (loginActive(state)) {
      seq.current++
      api.claudeLogin({ action: 'cancel' }).catch(() => {})
    }
    onClose()
  }
  const note = lost ? LOGIN_LOST_NOTE : loginNote(state)
  return (
    <div className="auth-login">
      {state.url && (
        <ol>
          <li>
            <a href={state.url} target="_blank" rel="noopener noreferrer">
              ログインのページを開く
            </a>
            （いま見ている端末のブラウザで開きます。Mac では開きません）
          </li>
          <li>
            ログインすると出るコードを貼る:
            {loginAcceptsCode(state) && (
              <span className="code">
                <input
                  type="text"
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !e.nativeEvent.isComposing) send()
                  }}
                  placeholder="コード"
                  aria-label="ログインのページに出たコード"
                  autoComplete="off"
                  autoCapitalize="off"
                  spellCheck={false}
                />
                {/* 渡したあとも止めない（子が「違う」と言わない版でも、貼り直せる） */}
                <button type="button" onClick={send} disabled={!code.trim()}>
                  送る
                </button>
              </span>
            )}
          </li>
        </ol>
      )}
      {note && <span className="note">{note}</span>}
      {error && <span className="note err">{error}</span>}
      <button type="button" className="linkish" onClick={close}>
        {loginActive(state) ? 'やめる' : '閉じる'}
      </button>
    </div>
  )
}
