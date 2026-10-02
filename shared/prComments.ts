// GitHub の PR に付いている会話のコメントとレビュー（#600）。`gh pr view --json comments,reviews` を読むだけ。
// DOM にも gh にも触らないので prComments.test.ts を node:test で回す。
import type { PrComment } from './types.ts'

/** 1 本の PR で返す件数の上限。超えた分は**古い方**を落として数だけ返す（応答を膨らませない） */
export const PR_COMMENTS_MAX = 100
/** 1 件の本文の上限（文字数）。超えたら切って `truncated` を付ける */
export const PR_COMMENT_MAX_CHARS = 20_000

export interface PrCommentList {
  /** 時刻の古い順 */
  comments: PrComment[]
  /** 上限で落とした件数 */
  omitted: number
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '')

function authorOf(v: unknown): { login: string; bot: boolean } {
  if (!v || typeof v !== 'object') return { login: '', bot: false }
  const o = v as Record<string, unknown>
  const login = str(o.login)
  return { login, bot: o.is_bot === true || login.endsWith('[bot]') }
}

function clip(body: string): { body: string; truncated: boolean } {
  if (body.length <= PR_COMMENT_MAX_CHARS) return { body, truncated: false }
  // サロゲートペアの途中で切らない
  const points = Array.from(body)
  if (points.length <= PR_COMMENT_MAX_CHARS) return { body, truncated: false }
  return { body: points.slice(0, PR_COMMENT_MAX_CHARS).join(''), truncated: true }
}

/** GitHub のそのコメントへのリンクだけ通す（ほかの形は捨てる。画面はそのまま `href` に置く） */
const githubUrl = (v: unknown): string => (/^https:\/\/github\.com\/[^\s]+$/.test(str(v)) ? str(v) : '')

/**
 * `gh pr view <番号> --json comments,reviews` の出力を、時刻の順の 1 本の一覧にする。読めなければ null
 * （「コメントが無い」の空と分ける）。
 *
 * - **本文の無い `COMMENTED` のレビューは出さない**（行コメントを運ぶだけの入れ物。GitHub の画面でも行コメントだけが見える）。
 *   本文が無くても承認・修正の依頼は判定が中身なので出す
 * - `PENDING`（自分がまだ送っていない下書きのレビュー）は出さない
 * - 畳まれたもの（`isMinimized`）と bot のものは `folded` を付ける（画面は 1 行にして、押すと開く）
 */
export function parsePrComments(stdout: string): PrCommentList | null {
  let obj: unknown
  try {
    obj = JSON.parse(stdout)
  } catch {
    return null
  }
  if (!obj || typeof obj !== 'object') return null
  const o = obj as Record<string, unknown>
  if (!Array.isArray(o.comments) || !Array.isArray(o.reviews)) return null
  const all: PrComment[] = []
  const push = (kind: PrComment['kind'], raw: unknown) => {
    if (!raw || typeof raw !== 'object') return
    const c = raw as Record<string, unknown>
    const id = str(c.id)
    const at = str(kind === 'review' ? c.submittedAt : c.createdAt)
    if (!id || !at) return
    const state = kind === 'review' ? str(c.state) : ''
    if (state === 'PENDING') return
    const text = str(c.body)
    if (kind === 'review' && state === 'COMMENTED' && !text.trim()) return
    const { login, bot } = authorOf(c.author)
    const { body, truncated } = clip(text)
    const folded = c.isMinimized === true ? 'minimized' : bot ? 'bot' : ''
    all.push({
      id,
      kind,
      author: login,
      at,
      body,
      url: githubUrl(c.url),
      ...(state ? { state } : {}),
      ...(folded ? { folded } : {}),
      ...(truncated ? { truncated } : {}),
    })
  }
  for (const c of o.comments) push('comment', c)
  for (const r of o.reviews) push('review', r)
  // 時刻の古い順。読めない時刻・同じ時刻は元の並び（sort は安定）
  const time = (c: PrComment) => Date.parse(c.at) || 0
  all.sort((a, b) => time(a) - time(b))
  const omitted = Math.max(0, all.length - PR_COMMENTS_MAX)
  return { comments: omitted ? all.slice(omitted) : all, omitted }
}
