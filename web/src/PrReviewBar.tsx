/**
 * PR の画面の「GitHub に投稿の準備」（#526）。押すと確認の画面（`PrReviewModal`）を開くだけで、ここからは送らない。
 * 書いたセッションが見つかる PR では、入力欄に入れる方（#525）が既定なので控えめに出す（`secondary`）
 */
export function PrReviewBar({ count, hasBody, secondary, onOpen, onClear }: { count: number; hasBody: boolean; secondary: boolean; onOpen: () => void; onClear: () => void }) {
  return (
    <div className={`diff-comment-bar pr-review-bar${secondary ? ' secondary' : ''}`}>
      {!secondary && (
        <span className="n">{count > 0 || hasBody ? `下書き: 行コメント ${count} 件${hasBody ? '・全体のコメント' : ''}` : '行番号を押すと、その行にコメントを書けます'}</span>
      )}
      <button type="button" className={secondary ? 'linkish' : 'primary'} onClick={onOpen}>
        GitHub にレビューを投稿…
      </button>
      {!secondary && (count > 0 || hasBody) && (
        <button type="button" className="linkish" onClick={onClear}>全部消す</button>
      )}
    </div>
  )
}
