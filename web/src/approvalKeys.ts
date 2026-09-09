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
