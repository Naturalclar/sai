// 差分ビューアの行に付けるコメント（#511）。DOM に触らない純粋関数（diffComments.test.ts）。
//
// 書いたコメントはすぐには送らず**セッションごとに溜め**（localStorage の `sai.diffComments`）、
// 「入力欄に入れる」でまとめて返信の本文にする。送るのは返信欄から（端末への打ち込み・-p・queue・預かり・
// 失敗したら戻す、といった返信の経路をそのまま使うため。差分ビューアから直接送ると、それを全部作り直すことになる）。
//
// **差分は「いまの worktree」を開くたびに読み直したもの**なので、書いている間にエージェントが編集すると行がずれる。
// そこでコメントは行番号に加えて**その行の中身**も持ち、いまの差分で同じ場所の中身が違えば「行が変わりました」を出す
// （送るのは止めない。本文にも中身を引用するので、エージェントは行番号がずれていても当てられる）。

import type { DiffFile, DiffLine } from '../../shared/diff.ts'

/** どの区切りの差分か。ブランチの差分（base...HEAD）か、未コミットか */
export type DiffCommentSection = 'branch' | 'working'

export interface DiffComment {
  /** 1 つのコメントを指す（消すときに使う） */
  id: string
  section: DiffCommentSection
  path: string
  /** `old` は消した行（旧い側の行番号）、`new` は足した行と文脈の行（新しい側の行番号） */
  side: 'old' | 'new'
  line: number
  kind: DiffLine['kind']
  /** コメントを書いたときのその行の中身 */
  code: string
  body: string
}

/** 1 セッションに溜められる数の上限（壊れた localStorage で本文が膨らまないように） */
export const DIFF_COMMENTS_MAX = 100

const SECTION_LABEL: Record<DiffCommentSection, string> = { branch: 'ブランチの差分', working: '未コミット' }
const KIND_LABEL: Record<DiffLine['kind'], string> = { add: '追加した行', del: '消した行', ctx: '変えていない行' }

/** その行にコメントを付けるときの側と行番号。消した行は旧い側、ほかは新しい側 */
export function lineAnchor(line: DiffLine): { side: 'old' | 'new'; line: number } {
  return line.kind === 'del' ? { side: 'old', line: line.oldNo } : { side: 'new', line: line.newNo }
}

/** 同じ行のコメントか（区切り・パス・側・行番号） */
export function sameLine(c: Pick<DiffComment, 'section' | 'path' | 'side' | 'line'>, d: Pick<DiffComment, 'section' | 'path' | 'side' | 'line'>): boolean {
  return c.section === d.section && c.path === d.path && c.side === d.side && c.line === d.line
}

/**
 * localStorage の中身を読む。壊れていたら空、形の合わない項目は捨てる（`replyDrafts.ts` の `parseDrafts()` と同じ作法）
 */
export function parseDiffComments(raw: string | null): Record<string, DiffComment[]> {
  if (!raw) return {}
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return {}
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
  const out: Record<string, DiffComment[]> = {}
  for (const [id, list] of Object.entries(parsed as Record<string, unknown>)) {
    if (!Array.isArray(list)) continue
    const ok = list.filter(isComment).slice(0, DIFF_COMMENTS_MAX)
    if (ok.length > 0) out[id] = ok
  }
  return out
}

function isComment(value: unknown): value is DiffComment {
  if (!value || typeof value !== 'object') return false
  const c = value as Record<string, unknown>
  return (
    typeof c.id === 'string' &&
    (c.section === 'branch' || c.section === 'working') &&
    typeof c.path === 'string' &&
    (c.side === 'old' || c.side === 'new') &&
    typeof c.line === 'number' &&
    (c.kind === 'add' || c.kind === 'del' || c.kind === 'ctx') &&
    typeof c.code === 'string' &&
    typeof c.body === 'string' &&
    c.body.trim() !== ''
  )
}

/** そのセッションのコメントを置き換えた全体。空になったセッションは消す */
export function withDiffComments(all: Record<string, DiffComment[]>, id: string, list: readonly DiffComment[]): Record<string, DiffComment[]> {
  const next = { ...all }
  if (list.length === 0) delete next[id]
  else next[id] = list.slice(0, DIFF_COMMENTS_MAX)
  return next
}

/** いまの差分で、そのコメントの行（区切りは呼ぶ側が選ぶ）。ファイルや行が差分に無ければ null */
export function commentLine(comment: DiffComment, files: readonly DiffFile[]): DiffLine | null {
  const file = files.find((f) => f.path === comment.path)
  if (!file) return null
  for (const hunk of file.hunks) {
    for (const line of hunk.lines) {
      const at = lineAnchor(line)
      if (at.side === comment.side && at.line === comment.line) return line
    }
  }
  return null
}

/**
 * いまの差分で、そのコメントの行の中身が書いたときと違うか（エージェントが編集して行がずれた）。
 * ファイルや行が見つからないときも「変わった」にする。差分がまだ読めていない（null）ときは言わない
 */
export function commentMoved(comment: DiffComment, files: readonly DiffFile[] | null): boolean {
  if (!files) return false
  const line = commentLine(comment, files)
  return !line || line.text !== comment.code
}

/**
 * 返信の本文にする。ファイル・行・その行の中身（引用）・コメントの順で、並びは書いた順ではなく
 * 区切り → パス → 行番号（読む側が上から追えるように）
 */
export function formatDiffComments(list: readonly DiffComment[]): string {
  if (list.length === 0) return ''
  const sections = new Set(list.map((c) => c.section))
  const sorted = [...list].sort(
    (a, b) => (a.section === b.section ? 0 : a.section === 'branch' ? -1 : 1) || a.path.localeCompare(b.path) || a.line - b.line,
  )
  const order: DiffCommentSection[] = ['branch', 'working']
  const head = `差分へのコメントです（${order.filter((s) => sections.has(s)).map((s) => SECTION_LABEL[s]).join(' / ')}）。`
  const blocks = sorted.map((c) => {
    const where = sections.size > 1 ? `${SECTION_LABEL[c.section]}・${KIND_LABEL[c.kind]}` : KIND_LABEL[c.kind]
    const quote = c.code.trim() === '' ? '>' : `> ${c.code}`
    return `${c.path}:${c.line}（${where}）\n${quote}\n${c.body.trim()}`
  })
  return [head, ...blocks].join('\n\n')
}
