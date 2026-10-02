// PR のコメントを、その PR を書いたセッションの返信欄に入れるときの本文（#600 の案 3）。DOM に触らない純粋関数（prCommentQuote.test.ts）。
// **入れるだけで送らない**（差分・PR の行コメントの決まりのまま。送るのは人）。
import type { PrLineThread } from '../../shared/prLineComments.ts'
import type { PrComment, PrLineComment } from '../../shared/types.ts'
import { commentAuthor, reviewStateLabel } from './prCommentLabels.ts'

interface PrRef {
  number: number
  title: string
  url: string
}

/** 引用にする（各行の頭に `> `。空の行は `>` だけ） */
function quoted(text: string): string {
  return text
    .trim()
    .split('\n')
    .map((line) => (line.trim() === '' ? '>' : `> ${line.replace(/\r$/, '')}`))
    .join('\n')
}

/** サーバが本文を上限で切ったコメントに添える 1 行（#669 のレビュー。添えないと、途中で切れた文をエージェントが全文として読む） */
const cut = (c: { truncated?: boolean; url: string }): string =>
  c.truncated ? `\n（長いので途中までです。${c.url ? `全文: ${c.url}` : '全文は GitHub で読んでください'}）` : ''

/** 1 行目。どの PR の話かを先に書く（#525 と同じ。書かないとエージェントは自分の worktree の話と取り違える） */
const heading = (pr: PrRef, what: string): string => `PR #${pr.number}「${pr.title}」に付いた${what}です（${pr.url}）。`

/** 会話のコメント・レビュー 1 件。レビューは判定を添える。本文が無い（判定だけ）なら引用は付けない */
export function quotePrComment(pr: PrRef, c: PrComment): string {
  const state = c.kind === 'review' ? reviewStateLabel(c.state) : null
  const who = `${commentAuthor(c.author)}${state ? `（${state.label}）` : ''}:`
  const body = c.body.trim() ? `\n${quoted(c.body)}` : ''
  return `${heading(pr, c.kind === 'review' ? 'レビュー' : 'コメント')}\n\n${who}${body}${cut(c)}`
}

/**
 * 差分の行に付いたやり取り。ファイル・行・その行の中身（引用）のあとに、最初のコメントと返信を書いた人つきで並べる。
 * 行番号はいまの差分のもの、無ければ（前の版へのコメント）書かれたときのもの、どちらも無ければ（ファイル全体）パスだけ
 */
export function quotePrLineThread(pr: PrRef, thread: PrLineThread): string {
  const { root } = thread
  const no = root.line || root.original_line
  const where = no ? `${root.path}:${no}` : root.path
  const note = root.file_level ? '（ファイル全体へのコメント）' : !root.line ? '（前の版へのコメント。いまの差分ではこの行が変わっています）' : ''
  const code = root.code === undefined ? '' : `\n${root.code.trim() === '' ? '>' : `> ${root.code}`}`
  const one = (c: PrLineComment) => `${commentAuthor(c.author)}:\n${quoted(c.body)}${cut(c)}`
  return [heading(pr, '行コメント'), `${where}${note}${code}`, ...[root, ...thread.replies].map(one)].join('\n\n')
}
