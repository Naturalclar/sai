import { useEffect, useMemo, useState } from 'react'
import type { KeyboardEvent } from 'react'
import { MODE_LABEL, REPLY_MODES } from '../../shared/permissions.ts'
import type { ReplyingMap, SessionSummary } from '../../shared/types.ts'
import { api } from './api'
import { BackLink } from './BackLink'
import { modelChoices, MODEL_DEFAULT_LABEL } from './modelChoices'
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
  /** `claude --bg` で始めたときの短い ID（#462） */
  attach?: string
}

/** 候補を作る一覧。絞り込み無しで取るので、アーカイブ済みも別に取って足す */
const ALL = { project: '', repo: '', agent: '', date: '', host: '', days: '90' }

/** 始められるエージェント（#401。OpenCode は #452）。Grok だけは ID を先に決める口が無いので出さない */
const AGENTS = [
  { id: 'claude' as const, label: 'Claude Code', note: '別プロセス（claude -p）で回す。端末には出ない' },
  { id: 'codex' as const, label: 'Codex CLI', note: 'app-server で回す。端末には出ない' },
  { id: 'opencode' as const, label: 'OpenCode', note: 'serve で回す。端末には出ない。許可は画面から答えられる' },
]
/**
 * `claude --bg` で始めるとき（#462）。**許可・質問は画面から答えられない**（`--permission-prompt-tool` が使われない）ことを先に書く
 */
const BACKGROUND_NOTE = 'claude --bg で回す。あとから端末で claude attach して開ける。許可・質問は端末で開いて答える（画面からは答えられない）'
type NewAgent = (typeof AGENTS)[number]['id']
const isNewAgent = (value: string): value is NewAgent => AGENTS.some((a) => a.id === value)

/**
 * SAI の画面から新しいセッションを始める（#314。Codex は #401）。worktree は**記録にあるものから選ぶ**:
 * サーバには選んだ worktree の一番新しいセッション（`from`）を渡し、サーバがその `cwd` を使う（パスは送らない）。
 * 送ったら `NewSessionStarting` が最初の行を待って、そのセッションの画面へ移る
 */
export function NewSessionView({ replying, now, onOpenSidebar }: Props) {
  const [all, setAll] = useState<{ sessions: SessionSummary[]; host: string } | null>(null)
  const [loadError, setLoadError] = useState('')
  const [from, setFrom] = useState('')
  const [agent, setAgent] = useState<NewAgent>('claude')
  const [model, setModel] = useState('')
  const [mode, setMode] = useState('')
  // `claude --bg` で始める（#462。Claude だけ）
  const [background, setBackground] = useState(false)
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
  // モデルの候補は、そのエージェントで記録に出てきたもの（Claude は別名も。`modelChoices()` と同じ規則）
  const models = useMemo(
    () => modelChoices(agent, [...new Set((all?.sessions ?? []).filter((s) => s.agent === agent).flatMap((s) => s.models))], ''),
    [all, agent],
  )
  // 選んでいなければ一番新しい worktree
  const chosen = choices.find((w) => w.from === from) ?? choices[0] ?? null

  const start = async () => {
    const body = text.trim()
    if (!body || !chosen || busy) return
    setBusy(true)
    setError('')
    try {
      const res = await api.startSession({
        from: chosen.from,
        text: body,
        ...(agent === 'claude' ? {} : { agent }),
        ...(model ? { model } : {}),
        // 許可モードは Claude にしか渡らない（`replyCommand()` が `--permission-mode` を付けるのは Claude だけ）
        ...(mode && agent === 'claude' ? { permission_mode: mode } : {}),
        ...(background && agent === 'claude' ? { background: true } : {}),
      })
      setStarted({ id: res.id, text: body, since: Date.now(), ...(res.attach ? { attach: res.attach } : {}) })
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
        <span className="meta">記録にある worktree で、新しいセッションを始める</span>
      </div>
      {started ? (
        <NewSessionStarting
          key={`starting:${started.id}`}
          id={started.id}
          text={started.text}
          since={started.since}
          replying={replying?.[started.id]}
          now={now}
          {...(started.attach ? { attach: started.attach } : {})}
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
              エージェント
              <select
                value={agent}
                onChange={(e) => {
                  setAgent(isNewAgent(e.target.value) ? e.target.value : 'claude')
                  // 候補が入れ替わるので、選んでいたモデルは外す（Claude の別名は Codex にも OpenCode にも渡せない）
                  setModel('')
                }}
              >
                {AGENTS.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.label}
                  </option>
                ))}
              </select>
            </label>
            <label>
              モデル
              <select value={model} onChange={(e) => setModel(e.target.value)}>
                <option value="">{MODEL_DEFAULT_LABEL}</option>
                {models.map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </select>
            </label>
            {/* 許可モードは Claude だけ（Codex は app-server の承認、OpenCode は serve の保留で答える。#421） */}
            {agent === 'claude' && (
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
            )}
            {agent === 'claude' && (
              <label className="check">
                <input type="checkbox" checked={background} onChange={(e) => setBackground(e.target.checked)} />
                バックグラウンドで始める
              </label>
            )}
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
            <span className="note">{agent === 'claude' && background ? BACKGROUND_NOTE : AGENTS.find((a) => a.id === agent)?.note}</span>
          </div>
          {error && <div className="notice error">始められませんでした: {error}</div>}
        </form>
      )}
    </section>
  )
}
