// PR の行コメントを GitHub にレビューとして投稿する（#526）ときの判定と組み立て。**SAI が GitHub に書く唯一の口**。
// DOM にもプロセスにも触らない純粋関数なので、サーバ（受け付けと GitHub に渡す形）と画面（確認の画面）が同じものを使い、prReview.test.ts で回す。
//
// 縛り（CLAUDE.md の「SAI は外に出さない」の例外）:
// - 送るのは人が書いた本文とコメントだけ。宛先はサーバが記録で知っているリポジトリ（#524 と同じ）
// - **行の位置はそのまま渡さない**。サーバがいまの PR の差分でその行を探し、中身が書いたときと同じときだけ組み立てる（`githubReview()`）
// - 読んだときの head の SHA を `commit_id` に付け、進んでいれば送らない（呼ぶ側が見る）
// - Approve / Request changes は人が選んだときだけ。自分の PR には出さない（`reviewEvents()`）
import type { DiffFile, DiffLine } from './diff.ts'
import type { PrReviewEvent, PrReviewLineComment, PrReviewRequest } from './types.ts'

/** 全体のコメント・1 件の行コメントの上限（GitHub の本文の上限と同じ） */
export const REVIEW_BODY_MAX = 65_536
/** 1 回のレビューに載せる行コメントの上限（下書きの上限 `DIFF_COMMENTS_MAX` と同じ） */
export const REVIEW_COMMENTS_MAX = 100

export const REVIEW_EVENT_LABEL: Record<PrReviewEvent, string> = {
  COMMENT: 'Comment',
  APPROVE: 'Approve',
  REQUEST_CHANGES: 'Request changes',
}

/** 画面で選べる種類。**先頭が既定（COMMENT）**。自分の PR は GitHub が Approve / Request changes を受けないので COMMENT だけ */
export function reviewEvents(own: boolean): PrReviewEvent[] {
  return own ? ['COMMENT'] : ['COMMENT', 'APPROVE', 'REQUEST_CHANGES']
}

export function isReviewEvent(v: unknown): v is PrReviewEvent {
  return v === 'COMMENT' || v === 'APPROVE' || v === 'REQUEST_CHANGES'
}

/** その行にコメントを付けるときの側と行番号。消した行は旧い側、ほかは新しい側（#511 の `lineAnchor()` と同じ） */
export function anchorOf(line: DiffLine): { side: 'old' | 'new'; line: number } {
  return line.kind === 'del' ? { side: 'old', line: line.oldNo } : { side: 'new', line: line.newNo }
}

/**
 * 差分の中のその行。ファイルは表示に使うパス（消したファイルは旧いパス）で引く。見つからなければ null
 */
export function findDiffLine(files: readonly DiffFile[], at: Pick<PrReviewLineComment, 'path' | 'side' | 'line'>): DiffLine | null {
  const file = files.find((f) => (f.path || f.oldPath) === at.path)
  if (!file) return null
  for (const hunk of file.hunks) {
    for (const line of hunk.lines) {
      const a = anchorOf(line)
      if (a.side === at.side && a.line === at.line) return line
    }
  }
  return null
}

/** いまの差分でその行コメントがどうなっているか。`moved` = 行はあるが中身が違う、`missing` = 行ごと見当たらない */
export function reviewLineState(files: readonly DiffFile[], c: PrReviewLineComment): 'ok' | 'moved' | 'missing' {
  const line = findDiffLine(files, c)
  if (!line) return 'missing'
  return line.text === c.code ? 'ok' : 'moved'
}

/**
 * 行コメントを全体のコメントの末尾に移す（確認の画面の「全体のコメントに移す」）。
 * 行の位置を失っても何の話か分かるように、場所と書いたときの行の中身を引用する
 */
export function moveToBody(body: string, c: PrReviewLineComment): string {
  const quote = c.code.trim() === '' ? '>' : `> ${c.code}`
  const block = `\`${c.path}:${c.line}\`\n${quote}\n\n${c.body.trim()}`
  return body.trim() === '' ? block : `${body.trimEnd()}\n\n${block}`
}

/** 空の中身で送れない組み合わせ。送れるなら空文字 */
export function reviewEmptyReason(event: PrReviewEvent, body: string, comments: number): string {
  if (event === 'REQUEST_CHANGES' && body.trim() === '') return 'Request changes には全体のコメントが要ります'
  if (event === 'COMMENT' && body.trim() === '' && comments === 0) return 'コメントがありません'
  return ''
}

/**
 * 画面から来た body を確かめる。形が合わなければ理由を返す（400）。**位置の検査はここではしない**（差分が要るので `githubReview()`）
 */
export function parseReviewRequest(raw: unknown): { ok: true; req: PrReviewRequest } | { ok: false; error: string } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, error: 'body はオブジェクトで送ってください' }
  const b = raw as Record<string, unknown>
  if (!isReviewEvent(b.event)) return { ok: false, error: 'event は COMMENT / APPROVE / REQUEST_CHANGES のどれかです' }
  if (typeof b.body !== 'string' || [...b.body].length > REVIEW_BODY_MAX) return { ok: false, error: `body は ${REVIEW_BODY_MAX} 文字までの文字列です` }
  if (typeof b.commit_id !== 'string' || !/^[0-9a-f]{40}$/.test(b.commit_id)) return { ok: false, error: 'commit_id（読んだときの head の SHA）を送ってください' }
  if (!Array.isArray(b.comments) || b.comments.length > REVIEW_COMMENTS_MAX) return { ok: false, error: `comments は ${REVIEW_COMMENTS_MAX} 件までの配列です` }
  const comments: PrReviewLineComment[] = []
  for (const c of b.comments as unknown[]) {
    if (!c || typeof c !== 'object') return { ok: false, error: '行コメントの形が違います' }
    const o = c as Record<string, unknown>
    if (
      typeof o.path !== 'string' ||
      o.path === '' ||
      (o.side !== 'old' && o.side !== 'new') ||
      typeof o.line !== 'number' ||
      !Number.isInteger(o.line) ||
      o.line < 1 ||
      typeof o.code !== 'string' ||
      typeof o.body !== 'string' ||
      o.body.trim() === '' ||
      [...o.body].length > REVIEW_BODY_MAX
    ) {
      return { ok: false, error: '行コメントの形が違います' }
    }
    comments.push({ path: o.path, side: o.side, line: o.line, code: o.code, body: o.body })
  }
  const empty = reviewEmptyReason(b.event, b.body, comments.length)
  if (empty) return { ok: false, error: empty }
  return { ok: true, req: { event: b.event, body: b.body, commit_id: b.commit_id, comments } }
}

/** GitHub の `POST repos/<owner>/<repo>/pulls/<番号>/reviews` に渡す形 */
export interface GithubReview {
  commit_id: string
  event: PrReviewEvent
  body?: string
  comments: { path: string; line: number; side: 'LEFT' | 'RIGHT'; body: string }[]
}

/**
 * 画面の要求といまの PR の差分から、GitHub に渡す形を組み立てる。**行はサーバの差分から引き直し**、
 * 見当たらない・中身が違う行コメントが 1 つでもあれば組み立てずにその番号を返す（黙って送らない・黙って落とさない）
 */
export function githubReview(req: PrReviewRequest, files: readonly DiffFile[]): { ok: true; review: GithubReview } | { ok: false; stale: number[] } {
  const stale: number[] = []
  const comments: GithubReview['comments'] = []
  req.comments.forEach((c, i) => {
    const line = findDiffLine(files, c)
    if (!line || line.text !== c.code) {
      stale.push(i)
      return
    }
    const at = anchorOf(line)
    comments.push({ path: c.path, line: at.line, side: at.side === 'old' ? 'LEFT' : 'RIGHT', body: c.body.trim() })
  })
  if (stale.length > 0) return { ok: false, stale }
  const review: GithubReview = { commit_id: req.commit_id, event: req.event, comments }
  if (req.body.trim() !== '') review.body = req.body.trim()
  return { ok: true, review }
}

/**
 * `gh api` が失敗したときの理由。stdout に GitHub の応答（`{"message":…,"errors":[…]}`）が出ていればそれ、無ければ stderr の最後の行。
 * 画面にそのまま出すので長さを切る
 */
export function githubErrorText(stdout: string, stderr: string): string {
  let text = ''
  try {
    const o = JSON.parse(stdout) as { message?: unknown; errors?: unknown }
    const parts: string[] = []
    if (typeof o.message === 'string') parts.push(o.message)
    if (Array.isArray(o.errors)) {
      for (const e of o.errors) {
        if (typeof e === 'string') parts.push(e)
        else if (e && typeof e === 'object' && typeof (e as { message?: unknown }).message === 'string') parts.push((e as { message: string }).message)
      }
    }
    text = parts.join(': ')
  } catch {
    // JSON でない
  }
  if (!text) text = stderr.trim().split('\n').filter(Boolean).pop() ?? ''
  if (!text) text = 'gh api が失敗しました'
  return text.length > 300 ? `${text.slice(0, 300)}…` : text
}
