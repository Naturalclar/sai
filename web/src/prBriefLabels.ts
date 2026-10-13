// PR の要約（#790）の欄の文言。DOM に触らないので prBriefLabels.test.ts を node:test で回す。
import type { PrBrief } from '../../shared/types.ts'

/** 2 つのうち新しく作った方（この画面で作ったものと、サーバが覚えていたもの）。片方だけならそれ */
export function newerBrief(a: PrBrief | null, b: PrBrief | null): PrBrief | null {
  if (!a || !b) return a ?? b
  return a.at >= b.at ? a : b
}

/**
 * 作るボタンの文字。**いまの head・いまのコメントの数で作ってあれば空**（押しても同じものが返るだけなので出さない）。
 * **作ったときと口が違えば出す**（設定で要約の口を替えたあと、新しい口で作り直せるように。#794 のレビュー）
 */
export function briefButtonLabel(has: boolean, state: { stale: boolean; added: number } | null, otherMouth = false): string {
  if (!has || !state) return '要約を作る'
  return state.stale || state.added > 0 || otherMouth ? '要約を作り直す' : ''
}
