// 差分ビューアのコメントの口をファイルごとに分け、同じ中身かを比べる（#611）。DOM に依存しないので diffFileComments.test.ts で回す。
import type { DiffComment, DiffCommentSection } from './diffComments'

/** 行にコメントを付ける口（#511）。`DiffView` が受け取り、`DiffFileItem` にはそのファイルの分だけ渡す */
export interface DiffViewComments {
  section: DiffCommentSection
  list: readonly DiffComment[]
  onAdd: (comment: Omit<DiffComment, 'id'>) => void
  onRemove: (id: string) => void
}

/**
 * コメントをファイルごとに分ける。描画のたびに組む（コメントの件数ぶんで安い）。1 件足す・消すたびに全ファイルの口が新しくなっても、
 * `DiffFileItem` の memo は `sameComments()` で中身を比べるので描き直らない。
 * コメントの無いファイルにも口は要る（行番号を押せる）ので、空の一覧の口を 1 つ共用する
 */
export function perFileComments(comments: DiffViewComments | undefined): (path: string) => DiffViewComments | undefined {
  if (!comments) return () => undefined
  const byPath = new Map<string, DiffComment[]>()
  for (const c of comments.list) {
    const list = byPath.get(c.path)
    if (list) list.push(c)
    else byPath.set(c.path, [c])
  }
  const of = (list: readonly DiffComment[]): DiffViewComments => ({ section: comments.section, list, onAdd: comments.onAdd, onRemove: comments.onRemove })
  const perPath = new Map([...byPath].map(([path, list]) => [path, of(list)] as const))
  const empty = of([])
  return (path: string) => perPath.get(path) ?? empty
}

/** 口を中身で比べる（区切り・口・一覧の要素の同一性）。`useDiffComments` はコメントのオブジェクトを持ち越すので要素で比べられる */
export function sameComments(a: DiffViewComments | undefined, b: DiffViewComments | undefined): boolean {
  if (a === b) return true
  if (!a || !b) return false
  return a.section === b.section && a.onAdd === b.onAdd && a.onRemove === b.onRemove && a.list.length === b.list.length && a.list.every((c, i) => c === b.list[i])
}
