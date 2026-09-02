import { useRef, useState } from 'react'
import type { KeyboardEvent, SyntheticEvent } from 'react'
import { filterReplyTargets, mentionQuery, type ReplyTarget } from '../../shared/reply.ts'

/**
 * @ メンションで返信先を選ぶための道具（フィード用）。渡さなければ `@` はただの文字（セッション画面）。
 * 返信先の state は呼び出し側（FeedView）が持ち、ここは表示と選択だけ
 */
export interface MentionProps {
  /** 候補。再開できないものも含む（薄く出して選べない） */
  targets: ReplyTarget[]
  /** いまの返信先。チップに出す */
  target: ReplyTarget
  /** 手で選んだものなら true（✕ で既定に戻せる）。既定のままなら false */
  picked: boolean
  /** id を選ぶ。null で既定に戻す */
  onPick: (id: string | null) => void
}

interface Props {
  repo: string
  busy: boolean
  onSend: (text: string) => void
  mention?: MentionProps
}

/** 入力欄。Enter で送信、Shift+Enter で改行。IME 変換中の Enter は送らない */
export function ReplyBox({ repo, busy, onSend, mention }: Props) {
  const [text, setText] = useState('')
  // caret は「@ の検出」に使う。onChange と onSelect（カーソル移動）で追う
  const [caret, setCaret] = useState(0)
  // 候補のハイライト位置。検索語が変わったら 0 に戻したいので、どの検索語での位置かを一緒に持つ
  const [cursor, setCursor] = useState<{ query: string; index: number }>({ query: '', index: 0 })
  // Esc で閉じた検索語。続きを打って検索語が変われば開き直す
  const [dismissed, setDismissed] = useState<string | null>(null)
  const ref = useRef<HTMLTextAreaElement>(null)

  const hit = mention ? mentionQuery(text, caret) : null
  const open = hit !== null && dismissed !== hit.query
  const shown = open && mention ? filterReplyTargets(mention.targets, hit.query) : []
  const selectable = shown.filter((t) => !t.blocked)
  const index = hit && cursor.query === hit.query ? cursor.index : 0
  const active = selectable.length ? (selectable[Math.min(index, selectable.length - 1)] ?? null) : null
  const moveCursor = (i: number) => hit && setCursor({ query: hit.query, index: i })

  const track = (e: SyntheticEvent<HTMLTextAreaElement>) => setCaret(e.currentTarget.selectionStart)

  /** 候補を確定する。`@検索語` を入力欄から消し、返信先だけ差し替える（本文にメンションは残さない） */
  const pick = (t: ReplyTarget) => {
    if (!mention || !hit || t.blocked) return
    const next = text.slice(0, hit.start) + text.slice(caret)
    setText(next)
    setCaret(hit.start)
    setDismissed(null)
    mention.onPick(t.id)
    const el = ref.current
    if (el) {
      el.focus()
      requestAnimationFrame(() => el.setSelectionRange(hit.start, hit.start))
    }
  }

  const submit = () => {
    const t = text.trim()
    if (!t || busy) return
    onSend(t)
    setText('')
    setCaret(0)
  }

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    // 日本語入力の確定 Enter で送らない・選ばない（isComposing が立つ。古い実装は keyCode 229）
    const composing = e.nativeEvent.isComposing || e.keyCode === 229
    if (open && hit) {
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        moveCursor(Math.min(index + 1, Math.max(selectable.length - 1, 0)))
        return
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        moveCursor(Math.max(index - 1, 0))
        return
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        setDismissed(hit.query)
        return
      }
      if ((e.key === 'Enter' || e.key === 'Tab') && !composing) {
        e.preventDefault()
        if (active) pick(active)
        else setDismissed(hit.query) // 候補が無いときの Enter は送信せず閉じるだけ
        return
      }
    }
    if (e.key !== 'Enter' || e.shiftKey || composing) return
    e.preventDefault()
    submit()
  }

  return (
    <form
      className="reply"
      onSubmit={(e) => {
        e.preventDefault()
        submit()
      }}
    >
      {mention && (
        <div className="target" title={mention.target.id}>
          <span className="arrow">→</span>
          <b>#{mention.target.repo}</b>
          {mention.target.branch && <code>{mention.target.branch}</code>}
          {mention.target.title && <span className="title">「{mention.target.title}」</span>}
          {mention.picked ? (
            <button type="button" className="clear" onClick={() => mention.onPick(null)} aria-label="返信先を既定に戻す" title="返信先を既定に戻す">✕</button>
          ) : (
            <span className="hint">@ で変更</span>
          )}
        </div>
      )}
      <div className="row">
        <textarea
          ref={ref}
          value={text}
          onChange={(e) => {
            setText(e.target.value)
            track(e)
          }}
          onSelect={track}
          onKeyDown={onKeyDown}
          placeholder={`#${repo} に返信（Enter で送信、Shift+Enter で改行）`}
          rows={2}
          disabled={busy}
        />
        <button type="submit" disabled={busy || !text.trim()}>
          {busy ? '送信中…' : '送信'}
        </button>
      </div>
      {open && (
        <ul className="mention" role="listbox" aria-label="返信先">
          {shown.length === 0 && <li className="none">該当するセッションがありません</li>}
          {shown.map((t) => (
            <li
              key={t.id}
              role="option"
              aria-selected={t === active}
              aria-disabled={!!t.blocked || undefined}
              className={`${t.blocked ? 'blocked' : ''}${t === active ? ' active' : ''}`}
              title={t.id}
              // mousedown で選ぶ（click だと先に textarea が blur して caret が動く）
              onMouseDown={(e) => {
                e.preventDefault()
                pick(t)
              }}
              onMouseEnter={() => {
                const i = selectable.indexOf(t)
                if (i >= 0) moveCursor(i)
              }}
            >
              <b>#{t.repo}</b>
              {t.branch && <code>{t.branch}</code>}
              <span className="title">{t.title || '(無題)'}</span>
              {t.blocked && <span className="why">{t.blocked}</span>}
            </li>
          ))}
        </ul>
      )}
    </form>
  )
}
