import { useCallback, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { parseUnifiedDiff, type DiffFile } from '../../shared/diff.ts'
import { autoOpenPaths } from './diffOpen.ts'
import type { DiffComment, DiffCommentSection } from './diffComments'
import { DiffFileItem, type EditingAt } from './DiffFileItem'
import { ScrollTick, useScrollTick } from './useScrollTick.ts'
import type { DiffFileStat, DiffSection } from './api'

/** 行にコメントを付ける口（#511）。渡されたときだけ行番号が押せるようになる */
export interface DiffViewComments {
  section: DiffCommentSection
  list: readonly DiffComment[]
  onAdd: (comment: Omit<DiffComment, 'id'>) => void
  onRemove: (id: string) => void
}

/** 一覧のパス（新しい方）でパース済みの本文を引く。リネームは旧パスでも当たる */
function fileOf(files: readonly DiffFile[], path: string): DiffFile | undefined {
  return files.find((f) => f.path === path || f.oldPath === path)
}

/**
 * コメントをファイルごとに分ける（#611）。描画のたびに組む（コメントの件数ぶんで安い）。1 件足す・消すたびに全ファイルの `comments` が
 * 新しくなっても、`DiffFileItem` の memo は `comments` を中身（区切り・口・一覧の要素）で比べる（`sameComments`）ので描き直らない。
 * コメントの無いファイルにも口は要る（行番号を押せる）ので、空の一覧の口を 1 つ共用する
 */
function perFileComments(comments: DiffViewComments | undefined): (path: string) => DiffViewComments | undefined {
  if (!comments) return () => undefined
  const byPath = new Map<string, DiffComment[]>()
  for (const c of comments.list) (byPath.get(c.path) ?? byPath.set(c.path, []).get(c.path)!).push(c)
  const of = (list: readonly DiffComment[]): DiffViewComments => ({ section: comments.section, list, onAdd: comments.onAdd, onRemove: comments.onRemove })
  const perPath = new Map([...byPath].map(([path, list]) => [path, of(list)] as const))
  const empty = of([])
  return (path: string) => perPath.get(path) ?? empty
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
 * `comments` は呼び出し側が `useMemo` で同じものを渡す（毎回作ると `DiffFileItem` の memo が効かず、ポーリングのたびに全ファイルが描き直る）
 */
export function DiffView({ section, title, empty, action, comments }: { section: DiffSection; title: string; empty: string; action?: ReactNode; comments?: DiffViewComments }) {
  // patch のパースは重いので、同じ本文なら作り直さない（全部開くようになって行数が増えたぶん効く）
  const files = useMemo(() => parseUnifiedDiff(section.patch), [section.patch])
  const [open, setOpen] = useState<Record<string, boolean>>({})
  // コメント欄を開いている行（#511）。1 つだけ
  const [editing, setEditing] = useState<EditingAt | null>(null)
  const total = section.files.reduce((n, f) => n + f.added + f.removed, 0)
  const rootRef = useRef<HTMLDivElement>(null)
  const scroll = useScrollTick(rootRef)
  const commentsOf = perFileComments(comments)

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
                files={files}
                shown={open[f.path] ?? autoOpen.has(f.path)}
                onToggle={onToggle}
                comments={commentsOf(f.path)}
                editing={editing?.path === f.path ? editing : null}
                setEditing={setEditing}
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
