// 入力欄から ← でサイドバーへ戻れるか。DOM に依存しないので replyFocus.test.ts を node:test で回す。
// キーを受けるのは web/src/ReplyBox.tsx の onKeyDown（本文の中身を知っているのはそこだけで、
// window 側は isTypingTarget() で入力欄のキーを捨ててしまうため、sessionNav.ts には置けない）。

interface KeyLike {
  key: string
  metaKey: boolean
  ctrlKey: boolean
  altKey: boolean
  shiftKey: boolean
  isComposing: boolean
}

export interface LeaveState {
  /** 入力欄の本文。**空のときだけ**戻る（書きかけの文中の ← はカーソル移動のまま） */
  text: string
  /** `@` / `/` / `:` の候補メニューが開いている。開いていればメニューの操作を優先する */
  menuOpen: boolean
}

/**
 * `←` でサイドバーのいま開いている項目へ戻るか。
 * 本文が空で、候補メニューが閉じていて、IME 変換中でも修飾キー付きでもないときだけ true。
 * 画像だけ添えて本文が空のときも戻る（添付は消えないので、`→` で戻ってくればそのまま送れる）。
 * `⌘←`（行頭へ）や `⇧←`（選択）は触らない
 */
export function leavesToSidebar(e: KeyLike, state: LeaveState): boolean {
  if (e.key !== 'ArrowLeft') return false
  if (e.isComposing || e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return false
  return !state.menuOpen && state.text === ''
}
