// 許可のバブルのキーボードショートカット。判定だけを純粋関数にして node:test で回す（sessionNav.ts と同じ形）。
// キーを受けるのは web/src/ApprovalBubble.tsx で、一番上のバブルだけが window の keydown を **capture** で張る。
// capture なのは、入力欄（ReplyBox）の onKeyDown が ⌘Enter を「送信」として扱うより先に来たいため。
// 拾ったときだけ stopPropagation するので、答え待ちのバブルが無ければ ⌘Enter の送信は今までどおり。

/** ⌘Enter で許可、⌘⇧Enter で常に許可 */
export type ApprovalAction = 'allow' | 'always'

interface KeyLike {
  key: string
  metaKey: boolean
  ctrlKey: boolean
  altKey: boolean
  shiftKey: boolean
  isComposing: boolean
}

/**
 * キー入力が許可のショートカットのどれに当たるか。
 * `⌘Enter`（Windows / Linux の `Ctrl+Enter` も）で許可、`⌘⇧Enter` で常に許可。
 * `hasAlways` が false のバブル（`Edit` など「常に許可」のボタンが出ないもの）では `⌘⇧Enter` も許可に落とす。
 * **素の Enter は触らない**（入力欄の送信）。IME 変換中と Alt 付きは何もしない
 */
export function approvalAction(e: KeyLike, hasAlways: boolean): ApprovalAction | null {
  if (e.key !== 'Enter' || e.isComposing || e.altKey) return null
  if (!e.metaKey && !e.ctrlKey) return null
  if (!e.shiftKey) return 'allow'
  return hasAlways ? 'always' : 'allow'
}

/** 返信欄に付ける「どのセッションの入力欄か」の印（要対応の行の下の返信欄。#538 のレビュー） */
export const REPLY_FOR_ATTR = 'data-reply-for'

/**
 * そのキー入力を許可のショートカットとして受けてよいか。**別のセッションの入力欄で押されたものは受けない**。
 * 要対応は行ごとに返信欄を開いておくので、下段の返信欄で ⌘Enter を押すと一番上の（別のセッションの）許可が
 * 通ってしまう。`replyFor` は押された場所に一番近い印の値で、印の無い場所（セッション画面の入力欄など、
 * 返信先が許可と同じか分からないところ）は今までどおり受ける
 */
export function hotkeyApplies(replyFor: string | null, approvalEntity: string, elsewhere = false): boolean {
  // `elsewhere`: 許可とは別の場所で押された（#633）。受けない。
  // - モーダル（⌘K・レビューの確認など）の中: そのモーダルのもの（⌘K の ⌘Enter は「横に開く」）
  // - フォーカスの無いペインの中: `Ctrl+数字` で入力欄の無いペインへ移ると、キャレットは前のペインの入力欄に残る。
  //   そこで押した ⌘Enter はその入力欄の送信で、移った先のペインの許可ではない（#643 のレビュー）
  if (elsewhere) return false
  return replyFor === null || replyFor === approvalEntity
}
