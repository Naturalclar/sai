/**
 * 差分ビューアの上に出す、溜めたコメントの数と「入力欄に入れる」（#511）。`target` は入れる先のセッションの名前（#525）。
 * 送るのは返信欄から（端末への打ち込み・預かり・失敗したら戻す、を返信の経路のまま使う）。入れたら下書きは空にする
 */
export function DiffCommentBar({ count, onInsert, onClear, target }: { count: number; onInsert: () => void; onClear: () => void; target?: string }) {
  if (count === 0) return <div className="diff-comment-bar hint">行番号を押すと、その行にコメントを書けます。まとめて返信欄に入れて送れます</div>
  return (
    <div className="diff-comment-bar">
      <span className="n">コメント {count} 件</span>
      {/* 別のセッションの入力欄に入れるとき（PR の差分。#525）はどこに入るかを名前で出す */}
      <button type="button" className="primary" onClick={onInsert}>
        {target ? `「${target}」の入力欄に入れる` : '入力欄に入れる'}
      </button>
      <button type="button" className="linkish" onClick={onClear}>全部消す</button>
    </div>
  )
}
