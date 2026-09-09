import { useState } from 'react'
import { parseUnifiedDiff } from '../../shared/diff.ts'
import type { DiffFileStat, DiffSection } from './api'

const STATUS_LABEL: Record<DiffFileStat['status'], string> = {
  added: '追加',
  modified: '変更',
  deleted: '削除',
  renamed: '移動',
  binary: 'バイナリ',
  other: '',
}

/**
 * 差分のひとまとまり（ブランチの差分 / 未コミット）。ファイルの見出しを一覧で出し、押すと本文を開く。
 * 本文の木は shared/diff.ts が作る（HTML 文字列は作らない）
 */
export function DiffView({ section, title, empty }: { section: DiffSection; title: string; empty: string }) {
  const files = parseUnifiedDiff(section.patch)
  const patchOf = (path: string) => files.find((f) => f.path === path || f.oldPath === path)
  const [open, setOpen] = useState<Record<string, boolean>>({})
  const total = section.files.reduce((n, f) => n + f.added + f.removed, 0)

  return (
    <div className="diff-section">
      <div className="head">
        {title}
        <span className="n">
          {section.files.length ? `${section.files.length} ファイル · +${section.files.reduce((n, f) => n + f.added, 0)} −${section.files.reduce((n, f) => n + f.removed, 0)}` : ''}
        </span>
      </div>
      {section.files.length === 0 ? (
        <div className="none">{empty}</div>
      ) : (
        <ul className="files">
          {section.files.map((f) => {
            const shown = open[f.path] ?? section.files.length <= 5
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
                        {h.lines.map((l, j) => (
                          <div className={`ln ${l.kind}`} key={j}>
                            <span className="no old">{l.oldNo || ''}</span>
                            <span className="no new">{l.newNo || ''}</span>
                            <span className="sign">{l.kind === 'add' ? '+' : l.kind === 'del' ? '−' : ' '}</span>
                            <span className="src">{l.text || ' '}</span>
                          </div>
                        ))}
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
    </div>
  )
}
