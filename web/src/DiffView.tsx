import { useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { parseUnifiedDiff } from '../../shared/diff.ts'
import { autoOpenPaths } from './diffOpen.ts'
import { commentMoved, lineAnchor, sameLine, type DiffComment, type DiffCommentSection } from './diffComments'
import { DiffCommentEditor } from './DiffCommentEditor'
import { DiffCommentNote } from './DiffCommentNote'
import type { DiffFileStat, DiffSection } from './api'

/** 行にコメントを付ける口（#511）。渡されたときだけ行番号が押せるようになる */
export interface DiffViewComments {
  section: DiffCommentSection
  list: readonly DiffComment[]
  onAdd: (comment: Omit<DiffComment, 'id'>) => void
  onRemove: (id: string) => void
}

const STATUS_LABEL: Record<DiffFileStat['status'], string> = {
  added: '追加',
  modified: '変更',
  deleted: '削除',
  renamed: '移動',
  binary: 'バイナリ',
  other: '',
}

/** そのファイルを開いたときに描く行数（文脈行も数える）。本文の無いファイルは 0 */
function lineCount(files: ReturnType<typeof parseUnifiedDiff>, path: string): number {
  const file = files.find((f) => f.path === path || f.oldPath === path)
  return file ? file.hunks.reduce((n, h) => n + h.lines.length, 0) : 0
}

/**
 * 差分のひとまとまり（ブランチの差分 / 未コミット）。ファイルの見出しを一覧で出し、押すと本文を開く。
 * **最初は上から順に開いた状態**で出る（#221。予算を超えたぶんだけ閉じたまま）。
 * 本文の木は shared/diff.ts が作る（HTML 文字列は作らない）
 */
export function DiffView({ section, title, empty, action, comments }: { section: DiffSection; title: string; empty: string; action?: ReactNode; comments?: DiffViewComments }) {
  // patch のパースは重いので、同じ本文なら作り直さない（全部開くようになって行数が増えたぶん効く）
  const files = useMemo(() => parseUnifiedDiff(section.patch), [section.patch])
  const patchOf = (path: string) => files.find((f) => f.path === path || f.oldPath === path)
  const [open, setOpen] = useState<Record<string, boolean>>({})
  // コメント欄を開いている行（#511）。1 つだけ
  const [editing, setEditing] = useState<{ path: string; side: 'old' | 'new'; line: number } | null>(null)
  const total = section.files.reduce((n, f) => n + f.added + f.removed, 0)

  // 最初から開いておくファイル（#221）。上から順に、描画する行数が予算に収まるぶんだけ開く。
  // 普段の差分は全部開き、極端に大きいものだけ後ろが閉じたまま出る
  const autoOpen = useMemo(
    () => autoOpenPaths(section.files.map((f) => ({ path: f.path, lines: lineCount(files, f.path) }))),
    [section.files, files],
  )
  const closedByBudget = section.files.length - autoOpen.size

  return (
    <div className="diff-section">
      <div className="head">
        {title}
        <span className="n">
          {section.files.length ? `${section.files.length} ファイル · +${section.files.reduce((n, f) => n + f.added, 0)} −${section.files.reduce((n, f) => n + f.removed, 0)}` : ''}
        </span>
        {action}
      </div>
      {section.files.length === 0 ? (
        <div className="none">{empty}</div>
      ) : (
        <ul className="files">
          {section.files.map((f) => {
            const shown = open[f.path] ?? autoOpen.has(f.path)
            const file = patchOf(f.path)
            return (
              <li key={f.path}>
                <button type="button" className="file" aria-expanded={shown} onClick={() => setOpen((o) => ({ ...o, [f.path]: !shown }))}>
                  <span className="mark">{shown ? '▾' : '▸'}</span>
                  <code className="path">
                    {f.old_path && f.old_path !== f.path ? `${f.old_path} → ${f.path}` : f.path}
                  </code>
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
                    {file.hunks.map((h, i) => (
                      <div className="hunk" key={i}>
                        <div className="hh">{h.header}</div>
                        {h.lines.map((l, j) => {
                          const numbers = (
                            <>
                              <span className="no old">{l.oldNo || ''}</span>
                              <span className="no new">{l.newNo || ''}</span>
                            </>
                          )
                          if (!comments) {
                            return (
                              <div className={`ln ${l.kind}`} key={j}>
                                {numbers}
                                <span className="sign">{l.kind === 'add' ? '+' : l.kind === 'del' ? '−' : ' '}</span>
                                <span className="src">{l.text || ' '}</span>
                              </div>
                            )
                          }
                          // 行番号を押すとその行にコメントを書ける（#511。GitHub の「+」と同じ場所。狭い画面でも押せる大きさ）
                          const at = { section: comments.section, path: f.path, ...lineAnchor(l) }
                          const here = comments.list.filter((c) => sameLine(c, at))
                          const isEditing = editing !== null && editing.path === at.path && editing.side === at.side && editing.line === at.line
                          return (
                            <div key={j}>
                              <div className={`ln ${l.kind}${here.length ? ' commented' : ''}`}>
                                <button
                                  type="button"
                                  className="nos"
                                  aria-label={`${f.path}:${at.line} にコメント`}
                                  title="この行にコメントを書く"
                                  onClick={() => setEditing(isEditing ? null : { path: at.path, side: at.side, line: at.line })}
                                >
                                  {numbers}
                                </button>
                                <span className="sign">{l.kind === 'add' ? '+' : l.kind === 'del' ? '−' : ' '}</span>
                                <span className="src">{l.text || ' '}</span>
                              </div>
                              {here.map((c) => (
                                <DiffCommentNote key={c.id} comment={c} moved={commentMoved(c, files)} onRemove={() => comments.onRemove(c.id)} />
                              ))}
                              {isEditing && (
                                <DiffCommentEditor
                                  onCancel={() => setEditing(null)}
                                  onSave={(body) => {
                                    comments.onAdd({ ...at, kind: l.kind, code: l.text, body: body.trim() })
                                    setEditing(null)
                                  }}
                                />
                              )}
                            </div>
                          )
                        })}
                      </div>
                    ))}
                  </div>
                )}
                {shown && !file && <div className="patch"><div className="note">本文がありません（中身の無い変更、または落とされた分）</div></div>}
              </li>
            )
          })}
        </ul>
      )}
      {total === 0 && section.files.length > 0 && <div className="none">行の変更はありません（モードや名前だけ）</div>}
      {/* 予算で閉じたままにしたぶん。押せば開くので、なぜ閉じているかだけ伝える */}
      {closedByBudget > 0 && total > 0 && (
        <div className="none">差分が大きいので、下の {closedByBudget} ファイルは閉じたままにしています（押すと開きます）</div>
      )}
    </div>
  )
}
