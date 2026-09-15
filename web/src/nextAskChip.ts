// 入力欄の上に「次に送る文面の案」（#371）のチップを出すか。DOM を触らないので nextAskChip.test.ts で回す。
import { NEXT_ASK_MAX_CHARS } from '../../shared/nextAsk.ts'
import { suggestionLabel } from './replySuggest.ts'

/**
 * チップに出す文（出さないなら空）。**入力欄が空のときだけ**出す。
 * 打ちかけの続き（#219 / #349）とは場所が同じだが、あちらは `suggestFrom()` が本文の空では出さないので重ならない。
 * 押すと本文に入るだけで送らないのも、続きのチップと同じ
 */
export function nextAskChip(nextAsk: string | undefined, text: string): string {
  if (!nextAsk?.trim() || text.trim()) return ''
  // 続きのチップ（24 文字）より長く出す。案は全体を読んでから押すもので、入りきらない分は CSS が省略する
  return suggestionLabel(nextAsk.trim(), NEXT_ASK_MAX_CHARS)
}
