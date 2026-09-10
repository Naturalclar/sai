import { useEffect, useRef } from 'react'
import type { MouseEvent } from 'react'
import type { Approval, Profile, Replying, SessionSummary } from './api'
import { hm, md } from './format'
import { SynthTag } from './SynthTag'
import { HostTag } from './HostTag'
import { isRemoteHost } from '../../shared/host.ts'
import { ReplyingTag } from './ReplyingTag'
import { ArchivedTag } from './ArchivedTag'
import { WaitingTag } from './WaitingTag'
import { More } from './More'
import { projectName } from '../../shared/project.ts'
import { SessionArchiveButton } from './SessionArchiveButton'
import { ArchiveMark } from './ArchiveMark'
import { useArchive } from './useArchive'
import { useSwipe } from './useSwipe'
import { sessionPreview } from './sessionPreview.ts'

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
}

/**
 * サイドバーの一覧の1行。リンク（<a>）と、その上に重ねる「アーカイブ」のアイコンは兄弟にする
 * （<a> の中に <button> は置けない。押してもページを動かさない）。
 * タッチ端末では <a> を左にずらして、下のレール（アーカイブ / 戻す）を見せる
 */
export function SessionItem({ s, active, replying, profile, approval, now, swipe, reduced, selfHost, open, onOpenChange }: Props) {
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
    }
  }

  const cls = ['item', active && 'active', s.archived && 'archived', sw.dragging && 'dragging', open && 'open'].filter(Boolean).join(' ')
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
          {s.meta?.name || s.title || '(無題)'}
          {isRemoteHost(s.host, selfHost) && <HostTag host={s.host} />}
          {s.session_source === 'synth' && <SynthTag />}
          {s.waiting && <WaitingTag text={s.waiting} />}
          {!s.waiting && approval && <WaitingTag text={approval.text} />}
          {replying && <ReplyingTag since={replying.since} now={now} />}
          {s.archived && <ArchivedTag />}
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
