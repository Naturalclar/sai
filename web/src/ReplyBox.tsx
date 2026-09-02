import { useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { KeyboardEvent, SyntheticEvent } from 'react'
import { filterReplyTargets, mentionLabels, mentionQuery, stripMention, type ReplyTarget } from '../../shared/reply.ts'
import { elapsedLabel } from './format'

/**
 * @ メンションで返信先を選ぶための道具（フィード用）。渡さなければ `@` はただの文字（セッション画面）。
 * 返信先の state は呼び出し側（FeedView）が持ち、ここは表示と選択だけ
 */
export interface MentionProps {
  /** 候補。再開できないものも含む（薄く出して選べない） */
  targets: ReplyTarget[]
  /** いまの返信先。チップに出す */
  target: ReplyTarget
  /**
   * 手で選んだもの（✕ で既定に戻せる）。既定のままなら null。
   * label は選んだ時点の表記で、本文の中に `@repo ` として入っている。送信時に外す
   */
  picked: Picked | null
  /** 選ぶ。null で既定に戻す */
  onPick: (picked: Picked | null) => void
}

export interface Picked {
  id: string
  label: string
}

interface Props {
  repo: string
  busy: boolean
  /** busy のとき、前の返信を起動した時刻。placeholder に「前の返信を処理中（3分）」と出す */
  busySince?: string
  /** 経過の基準（ポーリングの updatedAt）。busySince とセット */
  now?: number
  onSend: (text: string) => void
  mention?: MentionProps
}

/** 入力欄。Enter で送信、Shift+Enter で改行。IME 変換中の Enter は送らない */
export function ReplyBox({ repo, busy, busySince, now = 0, onSend, mention }: Props) {
  const [text, setText] = useState('')
  // caret は「@ の検出」に使う。onChange と onSelect（カーソル移動）で追う
  const [caret, setCaret] = useState(0)
  // 候補のハイライト位置。検索語が変わったら 0 に戻したいので、どの検索語での位置かを一緒に持つ
  const [cursor, setCursor] = useState<{ query: string; index: number }>({ query: '', index: 0 })
  // Esc で閉じた検索語。続きを打って検索語が変われば開き直す
  const [dismissed, setDismissed] = useState<string | null>(null)
  const ref = useRef<HTMLTextAreaElement>(null)
  // 確定で本文を差し替えた直後に置きたいカーソル位置。React が新しい値を書いた直後（描画前）に同期で当てる。
  // requestAnimationFrame だと、その前に打たれた文字の後ろへ戻ってしまう
  const wantCaret = useRef<number | null>(null)
  useLayoutEffect(() => {
    const el = ref.current
    if (el && wantCaret.current !== null) {
      el.setSelectionRange(wantCaret.current, wantCaret.current)
      wantCaret.current = null
    }
  })

  const labels = useMemo(() => mentionLabels(mention?.targets ?? []), [mention?.targets])
  const hit = mention ? mentionQuery(text, caret) : null
  const open = hit !== null && dismissed !== hit.query
  const shown = open && mention ? filterReplyTargets(mention.targets, hit.query) : []
  const selectable = shown.filter((t) => !t.blocked)
  const index = hit && cursor.query === hit.query ? cursor.index : 0
  const active = selectable.length ? (selectable[Math.min(index, selectable.length - 1)] ?? null) : null
  const moveCursor = (i: number) => hit && setCursor({ query: hit.query, index: i })

  const track = (e: SyntheticEvent<HTMLTextAreaElement>) => setCaret(e.currentTarget.selectionStart)

  /**
   * 候補を確定する。`@検索語` を、その候補の表記（`@repo ` のように空白付き）に置き換えて本文に残す。
   * Slack と同じで、入力欄の中に返信先が見える。前に選んだ表記が残っていればそれは外す（返信先は1つ）
   */
  const pick = (t: ReplyTarget) => {
    if (!mention || !hit || t.blocked) return
    const label = labels.get(t.id) ?? `@${t.repo}`
    const before = mention.picked ? stripMention(text.slice(0, hit.start), mention.picked.label) : text.slice(0, hit.start)
    const head = before && !/\s$/.test(before) ? `${before} ` : before
    const next = `${head}${label} ${text.slice(caret)}`
    const at = head.length + label.length + 1
    setText(next)
    setCaret(at)
    setDismissed(null)
    mention.onPick({ id: t.id, label })
    wantCaret.current = at
    ref.current?.focus()
  }

  /** 本文が変わったとき。選んだ表記が本文から消えていたら返信先も既定に戻す */
  const change = (next: string) => {
    setText(next)
    if (mention?.picked && !next.includes(mention.picked.label)) mention.onPick(null)
  }

  /** チップの ✕。表記も本文から外す */
  const clear = () => {
    if (!mention?.picked) return
    setText(stripMention(text, mention.picked.label))
    mention.onPick(null)
  }

  const submit = () => {
    // 送る本文からは表記を外す（エージェントにメンションは渡さない）
    const body = (mention?.picked ? stripMention(text, mention.picked.label) : text).trim()
    if (!body || busy) return
    onSend(body)
    setText('')
    setCaret(0)
    // 表記ごと本文が消えるので返信先も既定に戻す。送信中でも別の返信先へ続けて打てる
    if (mention?.picked) mention.onPick(null)
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
          {mention.target.icon && <span className="icon">{mention.target.icon}</span>}
          <b>#{mention.target.repo}</b>
          {mention.target.branch && <code>{mention.target.branch}</code>}
          {mention.target.title && <span className="title">「{mention.target.title}」</span>}
          {mention.picked ? (
            <button type="button" className="clear" onClick={clear} aria-label="返信先を既定に戻す" title="返信先を既定に戻す">✕</button>
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
            change(e.target.value)
            track(e)
          }}
          onSelect={track}
          onKeyDown={onKeyDown}
          placeholder={
            busy
              ? `前の返信を処理中${busySince && elapsedLabel(busySince, now) ? `（${elapsedLabel(busySince, now)}）` : ''}。終わるまで待ってください`
              : `#${repo} に返信（Enter で送信、Shift+Enter で改行）`
          }
          rows={2}
          // フィードでは送信中でも別の返信先へ打てるよう入力欄は止めない（送信ボタンだけ止める）
          disabled={busy && !mention}
        />
        <button type="submit" disabled={busy || !(mention?.picked ? stripMention(text, mention.picked.label) : text).trim()}>
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
              {t.icon && <span className="icon">{t.icon}</span>}
              <b>{labels.get(t.id) ?? `@${t.repo}`}</b>
              <span className="title">{t.title || '(無題)'}</span>
              {t.blocked && <span className="why">{t.blocked}</span>}
            </li>
          ))}
        </ul>
      )}
    </form>
  )
}
