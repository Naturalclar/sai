import { memo, useMemo, useRef } from 'react'
import type { DiffFile, DiffLine } from '../../shared/diff.ts'
import type { DiffFileStat } from './api'
import { lineAnchor, sameLine, type DiffComment } from './diffComments'
import { DiffCommentEditor } from './DiffCommentEditor'
import { DiffCommentNote } from './DiffCommentNote'
import { DiffFilePatch, pinKey } from './DiffFilePatch'
import { PrLineThreadNote } from './PrLineThreadNote'
import type { PlacedLineThread } from '../../shared/prLineComments.ts'
import { sameComments, type DiffViewComments } from './diffFileComments.ts'
import { collapseScrollBy } from './diffSticky.ts'
import { useScrollWatch } from './useScrollTick.ts'

const STATUS_LABEL: Record<DiffFileStat['status'], string> = {
  added: '追加',
  modified: '変更',
  deleted: '削除',
  renamed: '移動',
  binary: 'バイナリ',
  other: '',
}

const NO_COMMENTS: readonly DiffComment[] = []
const NO_THREADS: readonly PlacedLineThread[] = []

/** コメント欄を開いている行。コメントと同じ形（ファイル・側・番号） */
export type EditingAt = Pick<DiffComment, 'path' | 'side' | 'line'>

interface Props {
  f: DiffFileStat
  /** パースした本文。無ければ「本文がありません」 */
  file: DiffFile | undefined
  shown: boolean
  onToggle: (path: string) => void
  /** 行にコメントを付ける口（#511）。`list` は**このファイルの分だけ**（DiffView が分ける。他のファイルのコメントで描き直さない）。無ければ行番号は押せない */
  comments: DiffViewComments | undefined
  /** コメント欄を開いている行。このファイルのものだけ渡される（他のファイルの編集で描き直さない） */
  editing: EditingAt | null
  setEditing: (at: EditingAt | null) => void
  /**
   * GitHub でこのファイルの行に付いたやり取り（#600 の案 2）。**このファイルの分だけ**で、同じ中身なら同じ配列（`DiffView` が
   * ファイルごとに分けて覚える）。行の下に、書かれたものとして出す。その行は下書きのコメントと同じく常に DOM に置く
   */
  threads?: readonly PlacedLineThread[]
  /** 「何分前」の基準（読んだ時刻）。描画中に Date.now() を呼ばない */
  now?: number
}

/**
 * 差分の 1 ファイル（見出しのボタンと本文）。`memo`（比較は `sameProps`。`comments` は中身で比べる）で、
 * **他のファイルの開閉・編集・コメントではこのファイルを描き直さない**（#287 / #611）。
 * 本文の行は `DiffFilePatch` が見えている分だけ置く。コメントが付いている行と編集中の行は鍵の集合（`pinned`）で渡し、常に置かせる。
 * 行の下に描くもの（コメント・編集欄）は `renderLine` が行そのものを持っているので、そこで描く（行を探し直さない。#611）。
 * 見出しは開いている間、スクロール容器の上端に貼り付く（#644。CSS の `position: sticky`）。貼り付いた見出しから畳むときは、
 * 先にそのファイルの先頭までスクロールを戻す（`collapseScrollBy()`。戻さないと縮んだぶん下のファイルの途中に飛ぶ）
 */
function sameProps(a: Props, b: Props): boolean {
  return (
    a.f === b.f &&
    a.file === b.file &&
    a.shown === b.shown &&
    a.onToggle === b.onToggle &&
    a.editing === b.editing &&
    a.setEditing === b.setEditing &&
    a.threads === b.threads &&
    a.now === b.now &&
    sameComments(a.comments, b.comments)
  )
}

export const DiffFileItem = memo(function DiffFileItem({ f, file, shown, onToggle, comments, editing, setEditing, threads = NO_THREADS, now = 0 }: Props) {
  const sign = (l: DiffLine) => (l.kind === 'add' ? '+' : l.kind === 'del' ? '−' : ' ')
  const numbers = (l: DiffLine) => (
    <>
      <span className="no old">{l.oldNo || ''}</span>
      <span className="no new">{l.newNo || ''}</span>
    </>
  )

  const itemRef = useRef<HTMLLIElement>(null)
  const { scrollerRef } = useScrollWatch()
  const toggle = () => {
    const el = itemRef.current
    if (shown && el) {
      const scroller = scrollerRef.current
      const viewTop = scroller ? scroller.getBoundingClientRect().top + scroller.clientTop : 0
      const by = collapseScrollBy(el.getBoundingClientRect().top, viewTop)
      if (by) (scroller ?? window).scrollBy(0, by)
    }
    onToggle(f.path)
  }

  const here = comments?.list ?? NO_COMMENTS
  // 常に置く行の鍵（`pinKey()`）。コメントの集合と編集中の行が同じなら同じ Set（DiffFilePatch の memo が効く）
  const pinned = useMemo(() => {
    const keys = new Set<string>()
    for (const c of here) keys.add(pinKey(c))
    for (const t of threads) keys.add(pinKey(t))
    if (editing) keys.add(pinKey(editing))
    return keys
  }, [here, threads, editing])
  // 書いたあとに行が変わったコメント（エージェントが編集して行がずれた）。**このファイルの本文**で引く（`findDiffLine` は
  // `path || oldPath` の片方でしか当たらず、`oldPath` でしか引けないファイルでは全部「変わった」になる。#617 のレビュー）。
  // 描くたびに全行を歩かないよう、ファイルごとに 1 回
  const moved = useMemo(() => {
    const out = new Set<string>()
    if (!file || here.length === 0) return out
    const byKey = new Map<string, DiffLine>()
    for (const h of file.hunks) for (const l of h.lines) byKey.set(pinKey(l), l)
    for (const c of here) {
      const l = byKey.get(pinKey(c))
      if (!l || l.text !== c.code) out.add(c.id)
    }
    return out
  }, [file, here])

  const renderLine = (l: DiffLine, isPinned: boolean) => {
    const a = lineAnchor(l)
    // GitHub でこの行に付いたやり取り（#600）。コメントを書けない PR（書いたセッションが無く、gh も未ログイン）でも出す
    const posted = isPinned && threads.length > 0 ? threads.filter((t) => t.side === a.side && t.line === a.line) : []
    const postedNotes = posted.map((t) => <PrLineThreadNote key={t.thread.root.id} thread={t.thread} now={now} />)
    if (!comments) {
      return (
        <>
          <div className={`ln ${l.kind}${posted.length ? ' commented' : ''}`}>
            {numbers(l)}
            <span className="sign">{sign(l)}</span>
            <span className="src">{l.text || ' '}</span>
          </div>
          {postedNotes}
        </>
      )
    }
    // 行番号を押すとその行にコメントを書ける（#511。GitHub の「+」と同じ場所。狭い画面でも押せる大きさ）
    const at = { ...a, section: comments.section, path: f.path }
    const notes = isPinned ? here.filter((c) => sameLine(c, at)) : []
    const isEditing = editing !== null && editing.side === a.side && editing.line === a.line
    return (
      <>
        <div className={`ln ${l.kind}${notes.length || posted.length ? ' commented' : ''}`}>
          <button
            type="button"
            className="nos"
            aria-label={`${f.path}:${a.line} にコメント`}
            title="この行にコメントを書く"
            onClick={() => setEditing(isEditing ? null : { ...a, path: f.path })}
          >
            {numbers(l)}
          </button>
          <span className="sign">{sign(l)}</span>
          <span className="src">{l.text || ' '}</span>
        </div>
        {postedNotes}
        {notes.map((c) => (
          <DiffCommentNote key={c.id} comment={c} moved={moved.has(c.id)} onRemove={() => comments.onRemove(c.id)} />
        ))}
        {isPinned && isEditing && (
          <DiffCommentEditor
            onCancel={() => setEditing(null)}
            onSave={(body) => {
              comments.onAdd({ ...at, kind: l.kind, code: l.text, body: body.trim() })
              setEditing(null)
            }}
          />
        )}
      </>
    )
  }

  return (
    <li ref={itemRef}>
      <button type="button" className="file" aria-expanded={shown} onClick={toggle}>
        <span className="mark">{shown ? '▾' : '▸'}</span>
        <code className="path">{f.old_path && f.old_path !== f.path ? `${f.old_path} → ${f.path}` : f.path}</code>
        {STATUS_LABEL[f.status] && <span className={`tag ${f.status}`}>{STATUS_LABEL[f.status]}</span>}
        {/* GitHub でこのファイルの行に付いたやり取りの数（#600）。閉じているファイルにコメントがあることが分かるように見出しに出す */}
        {threads.length > 0 && <span className="tag posted" title="GitHub で行に付いたコメント">コメント {threads.length}</span>}
        <span className="counts">
          {f.added > 0 && <span className="add">+{f.added}</span>}
          {f.removed > 0 && <span className="del">−{f.removed}</span>}
        </span>
      </button>
      {shown && file && (
        <div className="patch">
          {file.binary && <div className="note">バイナリなので中身は出せません</div>}
          {file.skipped && <div className="note">大きすぎるので本文は出していません</div>}
          {file.hunks.length > 0 && <DiffFilePatch file={file} renderLine={renderLine} pinned={pinned} />}
        </div>
      )}
      {shown && !file && (
        <div className="patch">
          <div className="note">本文がありません（中身の無い変更、または落とされた分）</div>
        </div>
      )}
    </li>
  )
}, sameProps)
