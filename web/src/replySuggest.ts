// 返信の入力欄のオートサジェスト（#219）。打った文で始まる履歴の**続き**を薄く出し、`→` で受け入れる。
// fish シェルのオートサジェストと同じ操作。出典は #191 の履歴（replyHistory.ts の historyFrom）そのままで、
// サーバも新しい API も要らない。DOM を触らない純粋関数にして replySuggest.test.ts で回す。

interface KeyLike {
  key: string
  metaKey: boolean
  ctrlKey: boolean
  altKey: boolean
  shiftKey: boolean
  isComposing: boolean
}

/**
 * 打った文の続き。履歴（新しい順）のうち **text で始まって text より長い**一番新しいものの、残りを返す。
 * 無ければ空。
 * **本文が空のときは出さない**（fish と同じ。空で出すと毎回ゴーストが見えて、`→` が `↑`（履歴）とほぼ同じ働きになる）
 */
export function suggestFrom(history: readonly string[], text: string): string {
  if (!text) return ''
  for (const item of history) {
    if (item.length > text.length && item.startsWith(text)) return item.slice(text.length)
  }
  return ''
}

export interface AcceptState {
  /** カーソルの位置。**末尾のときだけ**受け入れる（文の途中の `→` はカーソル移動のまま） */
  caret: number
  /** 本文の長さ */
  length: number
  /** `@` / `/` / `:` の候補メニューが開いている。開いていればそちらの操作 */
  menuOpen: boolean
  /** いま出ている続き。空なら受け入れるものが無い */
  suggestion: string
}

/**
 * `→` を「続きの受け入れ」に使ってよいか。カーソルが末尾で、続きがあり、候補メニューが閉じていて、
 * IME 変換中でも修飾キー付きでもないときだけ。`⌘→`（行末へ）や `⇧→`（選択）は触らない。
 * window 側の `→`（入力欄へフォーカス。#204）は入力欄にフォーカスがあると発火しないので、こことは当たらない
 */
export function acceptsSuggestion(e: KeyLike, state: AcceptState): boolean {
  if (e.key !== 'ArrowRight') return false
  if (e.isComposing || e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return false
  return !state.menuOpen && state.suggestion !== '' && state.caret === state.length
}
