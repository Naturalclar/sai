import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { KeyboardEvent, SyntheticEvent } from 'react'
import { filterReplyTargets, mentionLabels, mentionQuery, stripMention, type ReplyTarget } from '../../shared/reply.ts'
import { filterSkills, skillSummary, slashQuery, type Skill } from '../../shared/skills.ts'
import { emojiQuery, filterEmoji, type EmojiHit } from '../../shared/emoji.ts'
import { elapsedLabel } from './format'
import { useSkills } from './useSkills'

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
  /** 返信を処理中のセッション。候補に「処理中」を付ける（選べるが、選ぶと送信が止まる） */
  busyIds?: ReadonlySet<string>
}

export interface Picked {
  id: string
  label: string
}

interface Props {
  repo: string
  /** 返信先が端末（tmux）で開いている = 打ち込む。false は -p で別プロセス。省略はどちらか分からない（フィード） */
  terminal?: boolean
  busy: boolean
  /** busy のとき、前の返信を起動した時刻。placeholder に「前の返信を処理中（3分）」と出す */
  busySince?: string
  /** 経過の基準（ポーリングの updatedAt）。busySince とセット */
  now?: number
  /** 送る。false を返したら（端末の打ちかけの確認待ちなど、送れなかった）本文を入力欄に戻す */
  onSend: (text: string) => void | boolean | Promise<void | boolean>
  /** 本文が空でないかが変わったら知らせる。FeedView は入力中に既定の返信先を動かさないために使う */
  onDraft?: (drafting: boolean) => void
  /** このセッションの返信で使うモデル（設定があれば）。placeholder に添える */
  replyModel?: string
  /** `/` でスキルの候補を出す返信先（エンティティID）。渡さなければ `/` はただの文字 */
  skillsId?: string
  mention?: MentionProps
}

/** 入力欄。Enter で送信、Shift+Enter で改行。IME 変換中の Enter は送らない */
export function ReplyBox({ repo, terminal, busy, busySince, now = 0, onSend, onDraft, replyModel, skillsId, mention }: Props) {
  const [text, setText] = useState('')
  // caret は「@ の検出」に使う。onChange と onSelect（カーソル移動）で追う
  const [caret, setCaret] = useState(0)
  // 候補のハイライト位置。検索語が変わったら 0 に戻したいので、どの検索語での位置かを一緒に持つ
  const [cursor, setCursor] = useState<{ query: string; index: number }>({ query: '', index: 0 })
  // Esc で閉じた検索語。続きを打って検索語が変われば開き直す
  const [dismissed, setDismissed] = useState<string | null>(null)
  // 処理中で送れないときに Enter を押した。黙って無視すると「送信できない」に見えるので理由を出す（#170）
  const [hitBusy, setHitBusy] = useState(false)
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

  // 入力に合わせて高さを伸ばす（Slack / Claude の返信欄と同じ）。上限は CSS の max-height（40vh）で、超えたらスクロール。
  // 毎描画で測るが、scrollHeight を読んで height を当てるだけなので安い（本文以外の描画でも幅が変われば合わせたい）
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${el.scrollHeight}px`
  })

  // 端末（tmux）で開いていれば、前のターンが動いていても打ち込める（TUI が次のターンに回す）。
  // 別プロセス（-p）の経路だけは二重起動になるので止める（#100, #170）
  const blocked = busy && terminal !== true

  const drafting = text.trim() !== ''
  useEffect(() => {
    onDraft?.(drafting)
  }, [drafting, onDraft])

  const labels = useMemo(() => mentionLabels(mention?.targets ?? []), [mention?.targets])
  const mentionHit = mention ? mentionQuery(text, caret) : null
  // `@` と `/` は同時には立たない（`/` は先頭だけ、`@` は前が空白か行頭）
  const slashHit = skillsId && !mentionHit ? slashQuery(text, caret) : null
  const skills = useSkills(skillsId, slashHit !== null)
  const shownSkills = slashHit ? filterSkills(skills, slashHit.query) : []
  // `:` は文中どこでも開くので、`@` と `/` が立っていないときだけ見る
  const emojiHit = !mentionHit && !slashHit ? emojiQuery(text, caret) : null
  const shownEmoji = emojiHit ? filterEmoji(emojiHit.query) : []
  const hit = mentionHit ?? slashHit ?? emojiHit
  const mentionOpen = mentionHit !== null && dismissed !== mentionHit.query
  // スキルは当たりが無ければ開かない。先頭がパス（`/Users/…`）のときに空の候補で Enter を食べないため
  const skillOpen = slashHit !== null && dismissed !== slashHit.query && shownSkills.length > 0
  // 絵文字も同じ。`14:08:30` のような時刻では当たりが無いので開かない
  const emojiOpen = emojiHit !== null && dismissed !== emojiHit.query && shownEmoji.length > 0
  const open = mentionOpen || skillOpen || emojiOpen
  const shown = mentionOpen && mention && mentionHit ? filterReplyTargets(mention.targets, mentionHit.query) : []
  const selectable = shown.filter((t) => !t.blocked)
  const index = hit && cursor.query === hit.query ? cursor.index : 0
  const active = selectable.length ? (selectable[Math.min(index, selectable.length - 1)] ?? null) : null
  const activeSkill = skillOpen && shownSkills.length ? (shownSkills[Math.min(index, shownSkills.length - 1)] ?? null) : null
  const activeEmoji = emojiOpen && shownEmoji.length ? (shownEmoji[Math.min(index, shownEmoji.length - 1)] ?? null) : null
  const count = skillOpen ? shownSkills.length : emojiOpen ? shownEmoji.length : selectable.length
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

  /** スキルの候補を確定する。本文の先頭を `/<name> ` にして、続けて引数を打てるようにする。展開は CLI に任せる */
  const pickSkill = (s: Skill) => {
    if (!slashHit) return
    const at = s.name.length + 2
    setText(`/${s.name} ${text.slice(caret)}`)
    setCaret(at)
    setDismissed(null)
    wantCaret.current = at
    ref.current?.focus()
  }

  /**
   * 絵文字の候補を確定する。`:名前` を**絵文字そのもの**に置き換える（`:tada:` ではなく 🎉 を本文に入れる）。
   * 送る本文にも絵文字が入るので、Markdown を通さない自分のバブルにも、エージェント側にもそのまま出る
   */
  const pickEmoji = (e: EmojiHit) => {
    if (!emojiHit) return
    const at = emojiHit.start + e.char.length
    setText(`${text.slice(0, emojiHit.start)}${e.char}${text.slice(caret)}`)
    setCaret(at)
    setDismissed(null)
    wantCaret.current = at
    ref.current?.focus()
  }

  /** 本文が変わったとき。選んだ表記が本文から消えていたら返信先も既定に戻す */
  const change = (next: string) => {
    setText(next)
    setHitBusy(false)
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
    if (!body) return
    if (blocked) {
      setHitBusy(true)
      return
    }
    const sent = text
    setText('')
    setCaret(0)
    // 表記ごと本文が消えるので返信先も既定に戻す。送信中でも別の返信先へ続けて打てる
    if (mention?.picked) mention.onPick(null)
    void Promise.resolve(onSend(body)).then((ok) => {
      // 送れなかった（端末の打ちかけの確認待ちなど）ら、まだ何も打っていなければ本文を戻す
      if (ok === false) setText((t) => (t ? t : sent))
    })
  }

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    // 日本語入力の確定 Enter で送らない・選ばない（isComposing が立つ。古い実装は keyCode 229）
    const composing = e.nativeEvent.isComposing || e.keyCode === 229
    if (open && hit) {
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        moveCursor(Math.min(index + 1, Math.max(count - 1, 0)))
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
        else if (activeSkill) pickSkill(activeSkill)
        else if (activeEmoji) pickEmoji(activeEmoji)
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
          {mention.target.icon && <img className="icon" src={mention.target.icon} alt="" />}
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
      {/* どこで回すかの短い注意。入力欄の上に 1 行。詳しい説明（送った返信は対話側の画面には出ない、など）は README の「返信」の節 */}
      <div className={`note${hitBusy && blocked ? ' blocked' : ''}`}>
        {hitBusy && blocked
          ? mention
            ? `#${repo} は前の返信を処理中。終わるまで待つか、@ で別のセッションに送ってください`
            : '前の返信を処理中。終わるまで待ってください'
          : terminal === true
            ? '端末（tmux）に打ち込む'
            : terminal === false
              ? '別プロセスで回す。端末には出ない'
              : '端末で開いていれば打ち込む'}
      </div>
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
              ? mention
                ? `#${repo} は前の返信を処理中${busySince && elapsedLabel(busySince, now) ? `（${elapsedLabel(busySince, now)}）` : ''}。@ で別のセッションに返信できます`
                : `前の返信を処理中${busySince && elapsedLabel(busySince, now) ? `（${elapsedLabel(busySince, now)}）` : ''}。終わるまで待ってください`
              : `#${repo} に返信（${replyModel ? `${replyModel} で回す。` : ''}Enter で送信、Shift+Enter で改行）`
          }
          rows={1}
          // フィードでは送信中でも別の返信先へ打てるよう入力欄は止めない（送信ボタンだけ止める）
          disabled={blocked && !mention}
        />
        <button type="submit" disabled={blocked || !(mention?.picked ? stripMention(text, mention.picked.label) : text).trim()}>
          {blocked ? (mention ? `#${repo} は処理中` : '送信中…') : '送信'}
        </button>
      </div>
      {skillOpen && (
        <ul className="mention skills" role="listbox" aria-label="スキル">
          {shownSkills.map((s) => (
            <li
              key={`${s.source}:${s.name}`}
              role="option"
              aria-selected={s === activeSkill}
              className={s === activeSkill ? 'active' : ''}
              // mousedown で選ぶ（click だと先に textarea が blur して caret が動く）
              onMouseDown={(e) => {
                e.preventDefault()
                pickSkill(s)
              }}
              onMouseEnter={() => {
                const i = shownSkills.indexOf(s)
                if (i >= 0) moveCursor(i)
              }}
            >
              <b>/{s.name}</b>
              <span className="title">{skillSummary(s.description)}</span>
              {s.source === 'project' && <span className="tag">プロジェクト</span>}
            </li>
          ))}
        </ul>
      )}
      {emojiOpen && (
        <ul className="mention emoji-list" role="listbox" aria-label="絵文字">
          {shownEmoji.map((e) => (
            <li
              key={e.name}
              role="option"
              aria-selected={e === activeEmoji}
              className={e === activeEmoji ? 'active' : ''}
              // mousedown で選ぶ（click だと先に textarea が blur して caret が動く）
              onMouseDown={(ev) => {
                ev.preventDefault()
                pickEmoji(e)
              }}
              onMouseEnter={() => {
                const i = shownEmoji.indexOf(e)
                if (i >= 0) moveCursor(i)
              }}
            >
              <span className="char">{e.char}</span>
              <b>:{e.name}:</b>
            </li>
          ))}
        </ul>
      )}
      {mentionOpen && (
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
              {t.icon && <img className="icon" src={t.icon} alt="" />}
              <b>{labels.get(t.id) ?? `@${t.repo}`}</b>
              <span className="title">{t.title || '(無題)'}</span>
              {mention?.busyIds?.has(t.id) && <span className="tag replying" title="前の返信を処理中。選べるが、終わるまで送れない">処理中</span>}
              {t.blocked && <span className="why">{t.blocked}</span>}
            </li>
          ))}
        </ul>
      )}
    </form>
  )
}
