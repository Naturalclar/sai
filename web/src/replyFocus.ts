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

/**
 * `Esc` で入力欄からフォーカスを外すか（#904）。候補メニューが閉じていて、IME 変換中でも修飾キー付きでもないときだけ true。
 * 本文があっても外す（打ちかけと添付は消さないので、`→` で戻ればそのまま続きを書ける）。
 * メニューが開いているときの `Esc` はメニューを閉じるだけ（1 回目でメニュー、2 回目で外れる）。
 * 外した同じ 1 回の `Esc` ではフィードへ移らない: window の `navAction()` は押した時点の `e.target`（入力欄）を
 * `isTypingTarget()` で見て捨てるので、フィードへはもう 1 回押したときに移る（その判定は App.tsx 側で、ここのテストでは見ていない）
 */
export function blursOnEscape(e: KeyLike, state: Pick<LeaveState, 'menuOpen'>): boolean {
  if (e.key !== 'Escape') return false
  if (e.isComposing || e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return false
  return !state.menuOpen
}
