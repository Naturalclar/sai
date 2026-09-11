import { useEffect, useMemo, useState } from 'react'
import type { KeyboardEvent } from 'react'
import { MODE_LABEL, REPLY_MODES } from '../../shared/permissions.ts'
import type { ReplyingMap, SessionSummary } from '../../shared/types.ts'
import { api } from './api'
import { BackLink } from './BackLink'
import { CLAUDE_ALIASES, MODEL_DEFAULT_LABEL } from './modelChoices'
import { NewSessionStarting } from './NewSessionStarting'
import { workspaceChoices, workspaceLabel } from './newSession'

interface Props {
  /** 一覧（App のポーリング）の処理中の返信。始めたセッションが最初の行を書く前に落ちたら、ここに failed が載る */
  replying: ReplyingMap | undefined
  /** 一覧を取った時刻（ms） */
  now: number
  onOpenSidebar: () => void
}

interface Started {
  id: string
  text: string
  since: number
}

/** 候補を作る一覧。絞り込み無しで取るので、アーカイブ済みも別に取って足す */
const ALL = { project: '', repo: '', agent: '', date: '', host: '', days: '90' }

/**
 * SAI の画面から新しいセッションを始める（#314。まず Claude だけ）。worktree は**記録にあるものから選ぶ**:
 * サーバには選んだ worktree の一番新しいセッション（`from`）を渡し、サーバがその `cwd` を使う（パスは送らない）。
 * 送ったら `NewSessionStarting` が最初の行を待って、そのセッションの画面へ移る
 */
export function NewSessionView({ replying, now, onOpenSidebar }: Props) {
  const [all, setAll] = useState<{ sessions: SessionSummary[]; host: string } | null>(null)
  const [loadError, setLoadError] = useState('')
  const [from, setFrom] = useState('')
  const [model, setModel] = useState('')
  const [mode, setMode] = useState('')
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [started, setStarted] = useState<Started | null>(null)

  // 候補は絞り込み無しの一覧から 1 回だけ（⌘K と同じ。サイドバーの絞り込みで worktree が隠れないように。3 秒のポーリングには乗せない）
  useEffect(() => {
    let alive = true
    Promise.all([api.sessions({ ...ALL, archived: '' }), api.sessions({ ...ALL, archived: '1' })])
      .then(([live, archived]) => {
        if (alive) setAll({ sessions: [...live.sessions, ...archived.sessions], host: live.host })
      })
      .catch((err: unknown) => {
        if (alive) setLoadError(err instanceof Error ? err.message : String(err))
      })
    return () => {
      alive = false
    }
  }, [])

  const choices = useMemo(() => (all ? workspaceChoices(all.sessions, all.host) : []), [all])
  // 選んでいなければ一番新しい worktree
  const chosen = choices.find((w) => w.from === from) ?? choices[0] ?? null

  const start = async () => {
    const body = text.trim()
    if (!body || !chosen || busy) return
    setBusy(true)
    setError('')
    try {
      const res = await api.startSession({ from: chosen.from, text: body, ...(model ? { model } : {}), ...(mode ? { permission_mode: mode } : {}) })
      setStarted({ id: res.id, text: body, since: Date.now() })
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  /** 返信の入力欄と同じく Enter で送り、Shift+Enter で改行。IME 変換中の Enter は送らない */
  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key !== 'Enter' || e.shiftKey || e.nativeEvent.isComposing || e.keyCode === 229) return
    e.preventDefault()
    void start()
  }

  return (
    <section>
      <BackLink onOpenSidebar={onOpenSidebar} />
      <div className="chat-head">
        <h1>新しいセッション</h1>
        <span className="meta">Claude Code を、記録にある worktree で始める</span>
      </div>
      {started ? (
        <NewSessionStarting
          key={`starting:${started.id}`}
          id={started.id}
          text={started.text}
          since={started.since}
          replying={replying?.[started.id]}
          now={now}
          onRetry={() => setStarted(null)}
        />
      ) : (
        <form
          className="new-session"
          onSubmit={(e) => {
            e.preventDefault()
            void start()
          }}
        >
          <label>
            worktree
            <select value={chosen?.from ?? ''} onChange={(e) => setFrom(e.target.value)} disabled={choices.length === 0}>
              {choices.map((w) => (
                <option key={w.from} value={w.from} title={w.cwd}>
                  {workspaceLabel(w)}
                </option>
              ))}
            </select>
          </label>
          {chosen && <div className="note cwd">{chosen.cwd}</div>}
          {all && choices.length === 0 && <div className="notice">始められる worktree がありません。端末でエージェントを 1 ターン回すと、その worktree がここに出ます</div>}
          {loadError && <div className="notice error">一覧を取れませんでした: {loadError}</div>}
          <div className="opts">
            <label>
              モデル
              <select value={model} onChange={(e) => setModel(e.target.value)}>
                <option value="">{MODEL_DEFAULT_LABEL}</option>
                {CLAUDE_ALIASES.map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </select>
            </label>
            <label>
              許可モード
              <select value={mode} onChange={(e) => setMode(e.target.value)}>
                <option value="">{MODE_LABEL.default}</option>
                {REPLY_MODES.map((m) => (
                  <option key={m} value={m}>
                    {MODE_LABEL[m]}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={onKeyDown}
            rows={5}
            placeholder="最初の指示（Enter で始める、Shift+Enter で改行）"
            aria-label="最初の指示"
          />
          <div className="actions">
            <button type="submit" disabled={busy || !text.trim() || !chosen}>
              {busy ? '始めています…' : '始める'}
            </button>
            <span className="note">別プロセス（claude -p）で回す。端末には出ない</span>
          </div>
          {error && <div className="notice error">始められませんでした: {error}</div>}
        </form>
      )}
    </section>
  )
}
