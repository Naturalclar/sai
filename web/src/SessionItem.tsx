import { useEffect, useRef } from 'react'
import type { MouseEvent } from 'react'
import type { Approval, Profile, Replying, SessionSummary } from './api'
import type { Loop } from '../../shared/types.ts'
import { LoopTag } from './LoopTag'
import { hm, md } from './format'
import { SynthTag } from './SynthTag'
import { HostTag } from './HostTag'
import { isRemoteHost } from '../../shared/host.ts'
import { ReplyingTag } from './ReplyingTag'
import { ArchivedTag } from './ArchivedTag'
import { StopMissingTag } from './StopMissingTag'
import { ReturnedTag } from './ReturnedTag'
import { returnedFromArchive } from '../../shared/archiveReturn.ts'
import { WaitingTag } from './WaitingTag'
import { UnreadTag } from './UnreadTag'
import { SessionPrTag } from './SessionPrTag'
import type { PrSummary } from '../../shared/types.ts'
import { More } from './More'
import { projectName } from '../../shared/project.ts'
import { SessionArchiveButton } from './SessionArchiveButton'
import { SessionSplitButton } from './SessionSplitButton'
import { ArchiveMark } from './ArchiveMark'
import { useArchive } from './useArchive'
import { useSwipe } from './useSwipe'
import { sessionPreview } from './sessionPreview.ts'
import { withSuffix } from '../../shared/sessionLabels.ts'

interface Props {
  s: SessionSummary
  active: boolean
  /** 画面から送った返信を処理中なら、その中身。「返信中」を付け、2 行目にも送った文を出す（#300） */
  replying: Replying | null
  /** 自分の表示名（2 行目の自分の返信に添える。無ければ「あなた」） */
  profile?: Profile
  /** 返信中のエージェントが答えを待っていれば、その先頭。「待機中」を付ける */
  approval: Approval | null
  /** 経過の基準（ポーリングの updatedAt） */
  now: number
  /** タッチ端末: 左にスワイプするとアーカイブのレールが出る。マウスなら何もしない */
  swipe: boolean
  /** 動きを追わず即座に開閉する（prefers-reduced-motion） */
  reduced: boolean
  /** このサーバのマシン名（#114）。違うマシンの行なら印を出す */
  selfHost: string
  /** レールが開いているか（一覧で 1 つだけ。SessionList が持つ） */
  open: boolean
  onOpenChange: (open: boolean) => void
  /** このセッションのブランチから出ている open な PR（#548。`prForSession()`）。無ければ印を出さない */
  pr?: PrSummary | null
  /** このセッションに組んであるループ（#634）。回っている・一時停止のあいだだけ印を出す */
  loop?: Loop | null
  /** フォーカスの無い方のペインに出ている（#633）。選ばれている項目より薄い印を付ける */
  beside?: boolean
  /** 横に並べて開く（#633。⌘ + クリックと項目のボタン）。並べられない幅では渡されない（⌘ + クリックはブラウザに残す） */
  onOpenBeside?: (() => void) | undefined
}

/**
 * サイドバーの一覧の1行。リンク（<a>）と、その上に重ねる「アーカイブ」のアイコンは兄弟にする
 * （<a> の中に <button> は置けない。押してもページを動かさない）。
 * タッチ端末では <a> を左にずらして、下のレール（アーカイブ / 戻す）を見せる
 */
export function SessionItem({ s, active, replying, profile, approval, now, swipe, reduced, selfHost, open, onOpenChange, pr = null, loop = null, beside = false, onOpenBeside }: Props) {
  // 選ばれたら見えるところまでサイドバーをスクロールする（キーボードで移動したとき用。見えていれば動かない）
  const ref = useRef<HTMLAnchorElement>(null)
  useEffect(() => {
    if (active) ref.current?.scrollIntoView({ block: 'nearest' })
  }, [active])

  // 合成 ID（synth）でもアーカイブできる（#248）。ID は record.py が記録時に決めて行に書き込むので、
  // 集計の切れ方や days の窓で変わらない（#31 の「付け先がずれる」は当時の見込みで、実装はそうなっていない）
  const archive = useArchive(s.id, Boolean(s.archived))
  const sw = useSwipe({
    enabled: swipe,
    open,
    onOpenChange,
    onCommit: () => {
      onOpenChange(false)
      void archive.toggle()
    },
    reduced,
  })

  // 開いている間はリンクを動かさず閉じるだけ。スワイプの直後に来る click も同じ
  const onClick = (e: MouseEvent<HTMLAnchorElement>) => {
    if (open || sw.swiped()) {
      e.preventDefault()
      onOpenChange(false)
      return
    }
    // ⌘ + クリック（Windows / Linux は Ctrl + クリック）は横に並べて開く（#633）。「新しいタブで開く」は奪う
    if (onOpenBeside && (e.metaKey || e.ctrlKey)) {
      e.preventDefault()
      onOpenBeside()
    }
  }

  const cls = ['item', active && 'active', beside && !active && 'beside', s.archived && 'archived', sw.dragging && 'dragging', open && 'open'].filter(Boolean).join(' ')
  // 2 行目は最後に誰が何を言ったか（#300）。自分が返信したら、次のターンを待たずに自分の返信になる
  const preview = sessionPreview(s, replying, profile)
  return (
    <div
      className={cls}
      data-id={s.id}
      onPointerDown={sw.onPointerDown}
      onPointerMove={sw.onPointerMove}
      onPointerUp={sw.onPointerUp}
      onPointerCancel={sw.onPointerCancel}
    >
      {swipe && (
        <div className="rail" aria-hidden={!open}>
          <button
            type="button"
            className="rail-btn"
            tabIndex={open ? 0 : -1}
            disabled={archive.busy}
            onClick={() => {
              onOpenChange(false)
              void archive.toggle()
            }}
          >
            <ArchiveMark restore={archive.shown} />
            {archive.error ? '失敗' : archive.shown ? '戻す' : 'アーカイブ'}
          </button>
        </div>
      )}
      <SessionArchiveButton archive={archive} />
      {onOpenBeside && !swipe && <SessionSplitButton onOpen={onOpenBeside} />}
      <a
        ref={ref}
        className="link"
        href={`#/s/${encodeURIComponent(s.id)}`}
        title={s.id}
        onClick={onClick}
        style={sw.dx !== 0 ? { transform: `translateX(${sw.dx}px)` } : undefined}
      >
        <span className="top">
          <span className="repo">
            <span className={`dot ${s.agent}`} />
            {/* bare clone だと repo は worktree 名なので、リポジトリ名（project）を出す。枝は右の branch で分かる */}
            {projectName(s.project) || s.repo || '—'}<More n={s.projects.length} />
            {s.branch && <span className="br"> / {s.branch}<More n={s.branches.length} /></span>}
          </span>
          <span className="when"><b>{md(s.end)}</b> {hm(s.end)} · {s.turns}</span>
        </span>
        <span className="t" title={s.title_full}>
          {s.icon && <img className="icon" src={s.icon} alt="" />}
          {withSuffix(s.meta?.name || s.title || '(無題)', s)}
          {isRemoteHost(s.host, selfHost) && <HostTag host={s.host} />}
          {s.session_source === 'synth' && <SynthTag />}
          {s.waiting && <WaitingTag text={s.waiting} />}
          {!s.waiting && approval && <WaitingTag text={approval.text} />}
          {replying && <ReplyingTag since={replying.since} now={now} />}
          {loop && <LoopTag loop={loop} now={now} />}
          {/* ターン完了の行が落ちた（#614。見出しと同じ `stop_missing`） */}
          {s.stop_missing && !replying && <StopMissingTag />}
          {!!s.unread && <UnreadTag n={s.unread} />}
          {pr && <SessionPrTag pr={pr} />}
          {s.archived && <ArchivedTag />}
          {returnedFromArchive(s) && <ReturnedTag at={returnedFromArchive(s)} />}
        </span>
        {preview && (
          <span className={`last${preview.from === 'me' ? ' mine' : ''}`}>
            {preview.who && <span className="who">{preview.who}:</span>} {preview.text}
          </span>
        )}
      </a>
    </div>
  )
}
