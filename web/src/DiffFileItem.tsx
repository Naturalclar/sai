import { memo, useMemo } from 'react'
import type { DiffFile, DiffLine } from '../../shared/diff.ts'
import type { DiffFileStat } from './api'
import { commentMoved, lineAnchor, sameLine, type DiffComment } from './diffComments'
import { DiffCommentEditor } from './DiffCommentEditor'
import { DiffCommentNote } from './DiffCommentNote'
import { DiffFilePatch } from './DiffFilePatch'
import type { DiffViewComments } from './DiffView'

const STATUS_LABEL: Record<DiffFileStat['status'], string> = {
  added: '追加',
  modified: '変更',
  deleted: '削除',
  renamed: '移動',
  binary: 'バイナリ',
  other: '',
}

const NO_COMMENTS: readonly DiffComment[] = []

/** コメント欄を開いている行。コメントと同じ形（ファイル・側・番号） */
export type EditingAt = Pick<DiffComment, 'path' | 'side' | 'line'>

interface Props {
  f: DiffFileStat
  /** パースした本文。無ければ「本文がありません」 */
  file: DiffFile | undefined
  /** パース済みの全ファイル（コメントの「行が変わりました」の判定に使う） */
  files: readonly DiffFile[]
  shown: boolean
  onToggle: (path: string) => void
  /** 行にコメントを付ける口（#511）。`list` は**このファイルの分だけ**（DiffView が分ける。他のファイルのコメントで描き直さない）。無ければ行番号は押せない */
  comments: DiffViewComments | undefined
  /** コメント欄を開いている行。このファイルのものだけ渡される（他のファイルの編集で描き直さない） */
  editing: EditingAt | null
  setEditing: (at: EditingAt | null) => void
}

/**
 * 差分の 1 ファイル（見出しのボタンと本文）。`memo`（比較は `sameProps`。`comments` は中身で比べる）で、
 * **他のファイルの開閉・編集・コメントではこのファイルを描き直さない**（#287 / #611）。
 * 本文の行は `DiffFilePatch` が見えている分だけ置く。コメントが付いている行と編集中の行は鍵の集合（`pinned`）で渡し、常に置かせる。
 * 行の下に描くもの（コメント・編集欄）は `renderLine` が行そのものを持っているので、そこで描く（行を探し直さない。#611）
 */
/** コメントの口を中身で比べる（区切り・口・一覧の要素の同一性）。`useDiffComments` はコメントのオブジェクトを持ち越すので要素で比べられる */
function sameComments(a: DiffViewComments | undefined, b: DiffViewComments | undefined): boolean {
  if (a === b) return true
  if (!a || !b) return false
  return a.section === b.section && a.onAdd === b.onAdd && a.onRemove === b.onRemove && a.list.length === b.list.length && a.list.every((c, i) => c === b.list[i])
}

function sameProps(a: Props, b: Props): boolean {
  return (
    a.f === b.f &&
    a.file === b.file &&
    a.files === b.files &&
    a.shown === b.shown &&
    a.onToggle === b.onToggle &&
    a.editing === b.editing &&
    a.setEditing === b.setEditing &&
    sameComments(a.comments, b.comments)
  )
}

export const DiffFileItem = memo(function DiffFileItem({ f, file, files, shown, onToggle, comments, editing, setEditing }: Props) {
  const sign = (l: DiffLine) => (l.kind === 'add' ? '+' : l.kind === 'del' ? '−' : ' ')
  const numbers = (l: DiffLine) => (
    <>
      <span className="no old">{l.oldNo || ''}</span>
      <span className="no new">{l.newNo || ''}</span>
    </>
  )

  const here = comments?.list ?? NO_COMMENTS
  // 常に置く行の鍵。コメントの集合と編集中の行が同じなら同じ Set（DiffFilePatch の memo が効く）
  const pinned = useMemo(() => {
    const keys = new Set<string>()
    for (const c of here) keys.add(`${c.side}:${c.line}`)
    if (editing) keys.add(`${editing.side}:${editing.line}`)
    return keys
  }, [here, editing])

  const renderLine = (l: DiffLine, isPinned: boolean) => {
    if (!comments) {
      return (
        <div className={`ln ${l.kind}`}>
          {numbers(l)}
          <span className="sign">{sign(l)}</span>
          <span className="src">{l.text || ' '}</span>
        </div>
      )
    }
    // 行番号を押すとその行にコメントを書ける（#511。GitHub の「+」と同じ場所。狭い画面でも押せる大きさ）
    const a = lineAnchor(l)
    const at = { section: comments.section, path: f.path, side: a.side, line: a.line }
    const notes = isPinned ? here.filter((c) => sameLine(c, at)) : []
    const isEditing = editing !== null && editing.side === a.side && editing.line === a.line
    return (
      <>
        <div className={`ln ${l.kind}${notes.length ? ' commented' : ''}`}>
          <button
            type="button"
            className="nos"
            aria-label={`${f.path}:${a.line} にコメント`}
            title="この行にコメントを書く"
            onClick={() => setEditing(isEditing ? null : { path: f.path, side: a.side, line: a.line })}
          >
            {numbers(l)}
          </button>
          <span className="sign">{sign(l)}</span>
          <span className="src">{l.text || ' '}</span>
        </div>
        {notes.map((c) => (
          <DiffCommentNote key={c.id} comment={c} moved={commentMoved(c, files)} onRemove={() => comments.onRemove(c.id)} />
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
    <li>
      <button type="button" className="file" aria-expanded={shown} onClick={() => onToggle(f.path)}>
        <span className="mark">{shown ? '▾' : '▸'}</span>
        <code className="path">{f.old_path && f.old_path !== f.path ? `${f.old_path} → ${f.path}` : f.path}</code>
        {STATUS_LABEL[f.status] && <span className={`tag ${f.status}`}>{STATUS_LABEL[f.status]}</span>}
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
