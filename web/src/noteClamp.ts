// 処理中の仮バブルに出す途中の文（#680）の、出す数と畳むかどうか。描く側は `ProgressNotes` / `ProgressNoteItem`
import type { ProgressNote } from '../../shared/types.ts'

/** これより長い（字数か行数）途中の文は畳んで出す */
export const NOTE_CLAMP_CHARS = 400
export const NOTE_CLAMP_LINES = 8

export const isLongNote = (text: string): boolean => Array.from(text).length > NOTE_CLAMP_CHARS || text.split('\n').length > NOTE_CLAMP_LINES

/**
 * 出す文（古い順の末尾 max 件）と、出していない数。`total` はそのターンの途中の文の数、`sent` は応答に載ってきた数
 * （応答は末尾だけ）。前のターンの文を落としたあとの `notes` が `sent` より少なければ、落とした分は「ほか」に数えない
 */
export function shownNotes(notes: readonly ProgressNote[], total: number, sent: number, max?: number): { shown: ProgressNote[]; earlier: number } {
  const shown = max === undefined ? [...notes] : notes.slice(-Math.max(0, max))
  if (shown.length === 0) return { shown, earlier: 0 }
  // 応答に載らなかった分（古い方）は、落とした文が無いときだけ同じターンのものと分かる
  const unsent = notes.length === sent ? Math.max(0, total - sent) : 0
  return { shown, earlier: unsent + (notes.length - shown.length) }
}
