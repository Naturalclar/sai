import { useCallback, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { parseUnifiedDiff, type DiffFile } from '../../shared/diff.ts'
import { autoOpenPaths } from './diffOpen.ts'
import { perFileComments, type DiffViewComments } from './diffFileComments.ts'
import { DiffFileItem, type EditingAt } from './DiffFileItem'
import { ScrollTick, useScrollTick } from './useScrollTick.ts'
import type { DiffFileStat, DiffSection } from './api'
import type { PlacedLineThread } from '../../shared/prLineComments.ts'

export type { DiffViewComments } from './diffFileComments.ts'

/** 一覧のパス（新しい方）でパース済みの本文を引く。リネームは旧パスでも当たる */
function fileOf(files: readonly DiffFile[], path: string): DiffFile | undefined {
  return files.find((f) => f.path === path || f.oldPath === path)
}

/** そのファイルを開いたときに描く行数（文脈行も数える）。本文の無いファイルは 0 */
function lineCount(files: readonly DiffFile[], path: string): number {
  const file = fileOf(files, path)
  return file ? file.hunks.reduce((n, h) => n + h.lines.length, 0) : 0
}

/**
 * 差分のひとまとまり（ブランチの差分 / 未コミット / PR の変更）。ファイルの見出しを一覧で出し、押すと本文を開く。
 * **最初は上から順に開いた状態**で出る（#221。予算を超えたぶんだけ閉じたまま）。
 * 本文の木は shared/diff.ts が作る（HTML 文字列は作らない）。
 * 本文の行は**見えている分だけ DOM に置く**（#287。ファイルごとに `DiffFileItem` → `DiffFilePatch`）。どこが見えているかは
 * この部品の祖先のスクロール容器（`.diff-scroll` など。無ければ window）を `useScrollTick` で見張り、`ScrollTick` で各ファイルに配る。
 * `threads`（GitHub で行に付いたやり取り。#600）もファイルごとに分けて渡す。
 * `comments` はファイルごとに分けて渡す（`perFileComments`）。`DiffFileItem` の memo は中身で比べるので、呼び出し側が同じオブジェクトを渡し続ける必要は無い
 */
export function DiffView({
  section,
  title,
  empty,
  action,
  comments,
  threads,
  now,
}: {
  section: DiffSection
  title: string
  empty: string
  action?: ReactNode
  comments?: DiffViewComments
  /** GitHub で行に付いたやり取り（#600 の案 2。PR の画面だけ）。行に当てたもの（`placeLineThreads()`）を渡す。同じ中身なら同じ配列を渡し続ける */
  threads?: readonly PlacedLineThread[]
  /** 「何分前」の基準（読んだ時刻） */
  now?: number
}) {
  // patch のパースは重いので、同じ本文なら作り直さない（全部開くようになって行数が増えたぶん効く）
  const files = useMemo(() => parseUnifiedDiff(section.patch), [section.patch])
  const [open, setOpen] = useState<Record<string, boolean>>({})
  // コメント欄を開いている行（#511）。1 つだけ
  const [editing, setEditing] = useState<EditingAt | null>(null)
  const total = section.files.reduce((n, f) => n + f.added + f.removed, 0)
  const rootRef = useRef<HTMLDivElement>(null)
  const scroll = useScrollTick(rootRef)
  const commentsOf = perFileComments(comments)
  // ファイルごとに分けて覚える（`DiffFileItem` の memo は配列の同一性で比べる。描くたびに分け直すと全ファイルが描き直る）
  const threadsOf = useMemo(() => {
    const byPath = new Map<string, PlacedLineThread[]>()
    for (const t of threads ?? []) {
      const list = byPath.get(t.path)
      if (list) list.push(t)
      else byPath.set(t.path, [t])
    }
    return byPath
  }, [threads])

  // 最初から開いておくファイル（#221）。上から順に、描画する行数が予算に収まるぶんだけ開く。
  // 普段の差分は全部開き、極端に大きいものだけ後ろが閉じたまま出る
  const autoOpen = useMemo(
    () => autoOpenPaths(section.files.map((f) => ({ path: f.path, lines: lineCount(files, f.path) }))),
    [section.files, files],
  )
  const closedByBudget = section.files.length - autoOpen.size
  const onToggle = useCallback((path: string) => setOpen((o) => ({ ...o, [path]: !(o[path] ?? autoOpen.has(path)) })), [autoOpen])

  return (
    <div className="diff-section" ref={rootRef}>
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
        <ScrollTick.Provider value={scroll}>
          <ul className="files">
            {section.files.map((f: DiffFileStat) => (
              <DiffFileItem
                key={f.path}
                f={f}
                file={fileOf(files, f.path)}
                shown={open[f.path] ?? autoOpen.has(f.path)}
                onToggle={onToggle}
                comments={commentsOf(f.path)}
                editing={editing?.path === f.path ? editing : null}
                setEditing={setEditing}
                {...(threadsOf.has(f.path) ? { threads: threadsOf.get(f.path)!, now: now ?? 0 } : {})}
              />
            ))}
          </ul>
        </ScrollTick.Provider>
      )}
      {total === 0 && section.files.length > 0 && <div className="none">行の変更はありません（モードや名前だけ）</div>}
      {/* 予算で閉じたままにしたぶん。押せば開くので、なぜ閉じているかだけ伝える */}
      {closedByBudget > 0 && total > 0 && (
        <div className="none">差分が大きいので、下の {closedByBudget} ファイルは閉じたままにしています（押すと開きます）</div>
      )}
    </div>
  )
}
