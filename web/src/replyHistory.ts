// 返信の入力欄の履歴（↑ で前に送った内容を呼び戻す）。シェルや Slack と同じ操作。
//
// 履歴はどこにも保存せず、**行の user_text から作る**。SAI から送った分も端末で打った分も同じように
// 載っている（record.py が UserPromptSubmit と Stop の両方に載せる）ので、これだけで足りる。
// DOM を触らない純粋関数にして replyHistory.test.ts で回す。
import { entityId } from '../../shared/entity.ts'
import type { FeedRow } from '../../shared/types.ts'

/** 履歴のどこにいるか。-1 は「履歴に入っていない（いま打っている本文）」 */
export const NOT_IN_HISTORY = -1

export interface HistoryState {
  /** 新しい順の履歴 */
  items: readonly string[]
  /** items の位置。NOT_IN_HISTORY なら履歴に入っていない */
  index: number
  /** 履歴に入る前に打ちかけていた本文。↓ で最後まで戻ったら返す */
  draft: string
}

/**
 * その返信先（エンティティ）に実際に入った入力を、新しい順に。
 * 同じ文が続けて載ること（入力の行と、そのあとの Stop の行）があるので連続する重複は畳む。
 * `extra` は送った直後でまだ行が届いていない分（useReply の処理中の返信）。あれば先頭に足す
 */
export function historyFrom(rows: readonly FeedRow[], id: string, extra: readonly string[] = []): string[] {
  const out: string[] = []
  for (let i = rows.length - 1; i >= 0; i--) {
    const row = rows[i]!
    if (entityId(row.session, row.repo, row.ts) !== id) continue
    const text = (row.user_text ?? '').trim()
    if (!text || text === out[out.length - 1]) continue
    out.push(text)
  }
  const items: string[] = []
  for (const text of [...extra.map((t) => t.trim()).filter(Boolean), ...out]) {
    if (text !== items[items.length - 1]) items.push(text)
  }
  return items
}

/** いまの本文とカーソル位置から、↑（前へ）に入れるか。空か、カーソルが1行目にあるときだけ */
export function canGoBack(text: string, caret: number): boolean {
  return !text || !text.slice(0, caret).includes('\n')
}

/** ↓（新しい方へ）に入れるか。空か、カーソルが最終行にあるときだけ */
export function canGoForward(text: string, caret: number): boolean {
  return !text || !text.slice(caret).includes('\n')
}

/**
 * ↑ / ↓ を押したときの次の状態。動かせなければ null（呼び出し側は既定のカーソル移動に任せる）。
 * 履歴に入るときは、そのとき打ちかけていた本文を draft に覚える
 */
export function stepHistory(state: HistoryState, dir: 'back' | 'forward', text: string): { text: string; state: HistoryState } | null {
  const { items, index } = state
  if (items.length === 0) return null
  if (dir === 'back') {
    const next = index + 1
    if (next >= items.length) return null
    // 履歴に入るときだけ、いまの本文を打ちかけとして覚える
    const draft = index === NOT_IN_HISTORY ? text : state.draft
    return { text: items[next]!, state: { items, index: next, draft } }
  }
  if (index === NOT_IN_HISTORY) return null
  const next = index - 1
  // 一番新しいものから ↓ を押したら、打ちかけに戻る
  if (next === NOT_IN_HISTORY) return { text: state.draft, state: { items, index: NOT_IN_HISTORY, draft: '' } }
  return { text: items[next]!, state: { items, index: next, draft: state.draft } }
}
