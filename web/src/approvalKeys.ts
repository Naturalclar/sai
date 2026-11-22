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
  /** 押しっぱなしの繰り返し。拒否・数字・質問の ⌘Enter は 1 回押した分だけ受ける（押しっぱなしで次の問いまで答えない） */
  repeat?: boolean
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

/**
 * 拒否のキー（#909）。`⌘.`（Windows / Linux は `Ctrl+.`）。Mac のダイアログの「キャンセル」と同じキーで、
 * 入力欄の編集のキー（`⌘⌫` = 行頭まで消す）とも、許可の `⌘Enter` とも離れているので押し間違えにくい。
 * ⇧・Alt 付き・IME 変換中は何もしない。押した場所の扱い（別のセッションの返信欄・モーダル・ほかのペイン）は
 * `⌘Enter` と同じく `hotkeyApplies()` で見る
 */
export function denyKey(e: KeyLike): boolean {
  if (e.key !== '.' || e.repeat || e.isComposing || e.altKey || e.shiftKey) return false
  return e.metaKey || e.ctrlKey
}

/**
 * 候補（Codex の app-server・端末のダイアログ）から、拒否のキーで押す 1 つを選ぶ（#909）。
 * **この 1 回だけの拒否**（`persists` の無い `deny`）に限る。「今後も断る」は押さない。
 * 名前が「拒否」のものがあればそれ（app-server は「拒否」と「ターンを中止」を並べる）、無ければ今回だけの拒否が
 * ちょうど 1 つのときだけそれ。決められなければ null（キーでは押さない）
 */
export function denyDecision(decisions: readonly { id: string; label: string; behavior: 'allow' | 'deny'; persists?: true }[]): string | null {
  const once = decisions.filter((d) => d.behavior === 'deny' && !d.persists)
  const named = once.filter((d) => d.label === '拒否')
  if (named.length === 1) return named[0]!.id
  return once.length === 1 ? once[0]!.id : null
}

/**
 * 質問（AskUserQuestion）の選択肢を数字で選ぶ（#909）。`1`〜`9` で、いまの問いの何番目か（0 始まり）を返す。
 * `count` は押せるものの数（選択肢に「その他」があればその分も足す）。範囲の外・修飾キー付き・IME 変換中は null。
 * **入力欄で打っている間（`typing`）は何もしない**（数字は文字のまま。「その他」の記入欄も入力欄）。呼び出し側は、
 * ほかの行のボタン・メニューにフォーカスがあるときも `typing` に含めて渡す（`AskQuestions`）
 */
export function optionIndex(e: KeyLike, count: number, typing: boolean): number | null {
  if (typing || e.repeat || e.isComposing || e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return null
  if (!/^[1-9]$/.test(e.key)) return null
  const index = Number(e.key) - 1
  return index < count ? index : null
}

/**
 * 質問のバブルで `⌘Enter` を押したときにすること（#909）。いまの問いに答えが無ければ何もしない（null）。
 * **質問の外の入力欄（返信欄など）で押したものは取らない**（`typingElsewhere`。選びかけの有無で送信になったりならなかったりしないように）。
 * 最後の問いでなければ次へ、最後の問いで**全部そろっていれば**送る。そろっていなければ null で、
 * 呼び出し側はキーを横取りしない（入力欄の送信に任せる）
 */
export function askEnterAction(last: boolean, currentAnswered: boolean, allReady: boolean, typingElsewhere = false): 'next' | 'send' | null {
  if (typingElsewhere || !currentAnswered) return null
  if (!last) return 'next'
  return allReady ? 'send' : null
}

/** `closest()` を持つもの（DOM の Element）。テストでは作り物を渡す */
interface PlaceLike {
  closest(selector: string): { getAttribute(name: string): string | null; classList: { contains(name: string): boolean } } | null
}

/**
 * 押された場所（`e.target`）で、許可・質問のキーを受けてよいか。`hotkeyApplies()` に渡す値を DOM から読む:
 * いちばん近い返信欄の印・モーダルの中か・フォーカスの無いペインの中か（#633）。
 * `blocked`（`keyBlocked()` が true）なら、どこで押されても受けない
 */
export function hotkeyAppliesAt(target: PlaceLike | null, approvalEntity: string, blocked = false): boolean {
  if (blocked) return false
  if (!target) return hotkeyApplies(null, approvalEntity)
  const owner = target.closest(`[${REPLY_FOR_ATTR}]`)
  const pane = target.closest('.pane')
  const elsewhere = target.closest('[role="dialog"]') !== null || (pane !== null && !pane.classList.contains('focused'))
  return hotkeyApplies(owner?.getAttribute(REPLY_FOR_ATTR) ?? null, approvalEntity, elsewhere)
}

/**
 * 押した場所に関わらず、そのバブルがキーを受けないとき（#909 のレビュー）:
 * - `modalOpen`: `.modal-backdrop` がある（Safari はリンクを押してもフォーカスが移らず、モーダルを開いたままの数字が裏に届く。ペインのキーと同じ扱い）
 * - `hidden`: バブルが画面に出ていない（狭い画面の `#/` では、隠れたペインも `focused` のまま残る）
 * - `inOtherBubble`: ほかの許可・質問のバブルの中で押された（下の質問の「その他」の ⌘Enter は、一番上のバブルのものではない）
 */
export function keyBlocked(p: { modalOpen: boolean; hidden: boolean; inOtherBubble: boolean }): boolean {
  return p.modalOpen || p.hidden || p.inOtherBubble
}

/**
 * 拒否のキー（`⌘.`）を受けてよい場所か（#909 のレビュー）。拒否は取り消せないので許可のキーより狭くする:
 * 入力欄の外か、**そのバブルのセッションの返信欄**（`ownReply`）で押したときだけ。検索欄・ほかのバブルの記入欄・
 * 返答の下の相手への入力欄（#700）では受けない
 */
export function denyPlaceOk(typing: boolean, ownReply: boolean): boolean {
  return !typing || ownReply
}
