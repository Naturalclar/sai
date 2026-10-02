// GitHub の PR の差分の行に付いたコメント（#600 の案 2。レビューの行コメントとその返信）。
// `gh api repos/<repo>/pulls/<番号>/comments` を読むだけ。DOM にも gh にも触らないので prLineComments.test.ts を node:test で回す。
import type { DiffFile, DiffLine } from './diff.ts'
import { clipBody, githubUrl } from './prComments.ts'
import { anchorOf } from './prReview.ts'
import type { PrLineComment } from './types.ts'

/** 1 本の PR で返す行コメントの上限。超えた分は**古い方**を落として数だけ返す */
export const PR_LINE_COMMENTS_MAX = 300

/**
 * `gh api --jq` に渡す絞り込み（**決め打ち**。リクエストからは作らない）。1 件を 1 行の JSON にして、要る項目だけ残す
 * （`diff_hunk` はコメントの付いた行の中身を取るためだけに読むので、**jq の中で最後の 2 行に切る**——最後が `\\ No newline…` のことがある。
 * 丸ごと受けると、長い hunk にコメントが多い PR で出力の上限を超えて全部読めなくなる。#668 のレビュー）
 */
export const LINE_COMMENTS_JQ =
  '.[] | {id, in_reply_to_id, path, line, original_line, side, subject_type, user: .user.login, user_type: .user.type, body, created_at, html_url, diff_hunk: ((.diff_hunk // "") | split("\n") | .[-2:] | join("\n"))}'

export interface PrLineCommentList {
  /** 時刻の古い順 */
  comments: PrLineComment[]
  /** 上限で落とした件数 */
  omitted: number
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '')
const int = (v: unknown): number => (typeof v === 'number' && Number.isInteger(v) && v > 0 ? v : 0)

/** `diff_hunk` の最後の行（コメントの付いた行）。頭の `+` / `-` / 空白を外した中身。読めなければ null */
export function hunkLastLine(hunk: string): string | null {
  if (!hunk) return null
  const lines = hunk.replace(/\r/g, '').split('\n')
  while (lines.length > 0 && (lines.at(-1) === '' || lines.at(-1)!.startsWith('\\'))) lines.pop()
  const last = lines.at(-1)
  if (last === undefined || last.startsWith('@@')) return null
  return /^[+\- ]/.test(last) ? last.slice(1) : null
}

/**
 * `gh api … --paginate --jq LINE_COMMENTS_JQ` の出力（1 行 1 件）。読めない行が 1 つでもあれば null
 * （切れた出力を「コメントが少ない」と読まない）。空の出力は 0 件
 */
export function parsePrLineComments(stdout: string): PrLineCommentList | null {
  const all: PrLineComment[] = []
  for (const raw of stdout.split('\n')) {
    if (!raw.trim()) continue
    let obj: unknown
    try {
      obj = JSON.parse(raw)
    } catch {
      return null
    }
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null
    const c = obj as Record<string, unknown>
    const id = int(c.id)
    const path = str(c.path)
    const at = str(c.created_at)
    if (!id || !path || !at) continue
    const login = str(c.user)
    const { body, truncated } = clipBody(str(c.body))
    const fileLevel = c.subject_type === 'file'
    const line = fileLevel ? 0 : int(c.line)
    const code = fileLevel ? null : hunkLastLine(str(c.diff_hunk))
    all.push({
      id,
      ...(int(c.in_reply_to_id) ? { reply_to: int(c.in_reply_to_id) } : {}),
      path,
      side: c.side === 'LEFT' ? 'old' : 'new',
      // いまの差分に当たる行。前の版へのコメント（outdated）とファイル全体へのコメントは 0
      line,
      original_line: int(c.original_line),
      ...(code !== null ? { code } : {}),
      ...(fileLevel ? { file_level: true } : {}),
      author: login,
      at,
      body,
      url: githubUrl(c.html_url),
      ...(c.user_type === 'Bot' || login.endsWith('[bot]') ? { bot: true } : {}),
      ...(truncated ? { truncated } : {}),
    })
  }
  const time = (c: PrLineComment) => Date.parse(c.at) || 0
  all.sort((a, b) => time(a) - time(b) || a.id - b.id)
  const omitted = Math.max(0, all.length - PR_LINE_COMMENTS_MAX)
  return { comments: omitted ? all.slice(omitted) : all, omitted }
}

/** 1 つの行に付いた、ひとまとまりのやり取り。場所は最初のコメントのもの */
export interface PrLineThread {
  root: PrLineComment
  /** 返信（古い順） */
  replies: PrLineComment[]
}

/**
 * 返信（`reply_to`）を最初のコメントの下にまとめる。GitHub の返信はいつも最初のコメントを指す。
 * 指す先が一覧に無い返信（上限で落ちた・消された）は、それ自身を最初のコメントとして出す（黙って落とさない）
 */
export function threadLineComments(comments: readonly PrLineComment[]): PrLineThread[] {
  const threads = new Map<number, PrLineThread>()
  for (const c of comments) if (!c.reply_to) threads.set(c.id, { root: c, replies: [] })
  for (const c of comments) {
    if (!c.reply_to) continue
    const parent = threads.get(c.reply_to)
    if (parent) parent.replies.push(c)
    else threads.set(c.id, { root: c, replies: [] })
  }
  return [...threads.values()]
}

/** 差分の行に当てたやり取り。`side` / `line` は**画面の行の鍵**（`anchorOf()`。消した行は旧い側、ほかは新しい側） */
export interface PlacedLineThread {
  thread: PrLineThread
  /** 一覧（`DiffFileStat`）のパス。リネームは新しい方 */
  path: string
  side: 'old' | 'new'
  line: number
}

function lineAt(file: DiffFile, side: 'old' | 'new', no: number): DiffLine | null {
  for (const hunk of file.hunks) {
    for (const l of hunk.lines) {
      // 新しい側は足した行と文脈の行、旧い側は消した行と文脈の行（左側の文脈の行に付けたコメントもある）
      if (side === 'new' ? l.kind !== 'del' && l.newNo === no : l.kind !== 'add' && l.oldNo === no) return l
    }
  }
  return null
}

/**
 * やり取りを、**いまの差分の行**に当てる。当てるのは次が全部そろったときだけ（行は取り違えない）:
 *
 * - GitHub がいまの差分の行番号（`line`）を返している（前の版へのコメント・ファイル全体へのコメントではない）
 * - そのファイルのその側にその行があり、**中身がコメントの付いた行（`code`）と同じ**（読んだ差分とコメントで head がずれていても、
 *   別の行には出さない）。`code` が取れなかったコメントは行番号だけで当てる
 *
 * 当たらなかったものは `rest`（画面は差分の上に「行に当てられなかったコメント」としてまとめて出す）
 */
export function placeLineThreads(threads: readonly PrLineThread[], files: readonly DiffFile[]): { placed: PlacedLineThread[]; rest: PrLineThread[] } {
  const placed: PlacedLineThread[] = []
  const rest: PrLineThread[] = []
  for (const thread of threads) {
    const { root } = thread
    // GitHub が返すのは新しいパス。**同じ名前のファイルを先に**探す（`b.ts` を `a.ts` に移して新しい `b.ts` を足した PR で、
    // 旧いパスが先に当たると別のファイルに出る。#668 のレビュー）。旧いパスは、消したファイルなど新しいパスで当たらないときだけ
    const file = root.line ? (files.find((f) => f.path === root.path) ?? files.find((f) => f.oldPath === root.path)) : undefined
    const l = file ? lineAt(file, root.side, root.line) : null
    // 改行が CRLF のファイルは、差分の行に `\r` が残る（`hunkLastLine()` は外している）ので、外して比べる
    if (!file || !l || (root.code !== undefined && root.code !== l.text.replace(/\r$/, ''))) {
      rest.push(thread)
      continue
    }
    placed.push({ thread, path: file.path || file.oldPath, ...anchorOf(l) })
  }
  return { placed, rest }
}
