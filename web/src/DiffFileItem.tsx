import { memo } from 'react'
import type { ReactNode } from 'react'
import type { DiffFile, DiffLine } from '../../shared/diff.ts'
import type { DiffFileStat } from './api'
import { findDiffLine } from '../../shared/prReview.ts'
import { commentMoved, lineAnchor, sameLine, type DiffComment, type DiffCommentSection } from './diffComments'
import { DiffCommentEditor } from './DiffCommentEditor'
import { DiffCommentNote } from './DiffCommentNote'
import { DiffFilePatch } from './DiffFilePatch'

const STATUS_LABEL: Record<DiffFileStat['status'], string> = {
  added: '追加',
  modified: '変更',
  deleted: '削除',
  renamed: '移動',
  binary: 'バイナリ',
  other: '',
}

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
  /** 行にコメントを付ける口（#511）。無ければ行番号は押せない */
  comments: { section: DiffCommentSection; list: readonly DiffComment[]; onAdd: (c: Omit<DiffComment, 'id'>) => void; onRemove: (id: string) => void } | undefined
  /** コメント欄を開いている行。このファイルのものだけ渡される（他のファイルの編集で描き直さない） */
  editing: EditingAt | null
  setEditing: (at: EditingAt | null) => void
}

/**
 * 差分の 1 ファイル（見出しのボタンと本文）。`memo` で、**他のファイルの開閉・編集ではこのファイルを描き直さない**（#287）。
 * 本文の行は `DiffFilePatch` が見えている分だけ置く。コメントが付いている行と編集中の行は `pinned` として渡し、常に置かせる
 */
export const DiffFileItem = memo(function DiffFileItem({ f, file, files, shown, onToggle, comments, editing, setEditing }: Props) {
  const sign = (l: DiffLine) => (l.kind === 'add' ? '+' : l.kind === 'del' ? '−' : ' ')
  const numbers = (l: DiffLine) => (
    <>
      <span className="no old">{l.oldNo || ''}</span>
      <span className="no new">{l.newNo || ''}</span>
    </>
  )

  // このファイルのコメント（行ごと）と編集中の行。行番号に印を付け、行の下に描くものを組む（list は呼び出し側が区切りで絞ってある）
  const here = comments ? comments.list.filter((c) => c.path === f.path) : []
  const pinned = new Map<string, ReactNode>()
  if (comments && file) {
    const at = (side: 'old' | 'new', line: number) => ({ section: comments.section, path: f.path, side, line })
    const keys = new Set<string>([...here.map((c) => `${c.side}:${c.line}`), ...(editing ? [`${editing.side}:${editing.line}`] : [])])
    for (const key of keys) {
      const [side, n] = key.split(':') as ['old' | 'new', string]
      const line = Number(n)
      const notes = here.filter((c) => sameLine(c, at(side, line)))
      const isEditing = editing !== null && editing.side === side && editing.line === line
      const src = findDiffLine([file], { path: f.path, side, line })
      pinned.set(
        key,
        <>
          {notes.map((c) => (
            <DiffCommentNote key={c.id} comment={c} moved={commentMoved(c, files)} onRemove={() => comments.onRemove(c.id)} />
          ))}
          {isEditing && src && (
            <DiffCommentEditor
              onCancel={() => setEditing(null)}
              onSave={(body) => {
                comments.onAdd({ ...at(side, line), kind: src.kind, code: src.text, body: body.trim() })
                setEditing(null)
              }}
            />
          )}
        </>,
      )
    }
  }

  const renderLine = (l: DiffLine) => {
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
    const commented = here.some((c) => c.side === a.side && c.line === a.line)
    const isEditing = editing !== null && editing.side === a.side && editing.line === a.line
    return (
      <div className={`ln ${l.kind}${commented ? ' commented' : ''}`}>
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
})
