/** まだ読んでいない返答の数（#502）。待機中とは別の軸（こちらが読んだか / 相手が人を待っているか）なので両方出る */
export function UnreadTag({ n }: { n: number }) {
  return (
    <span className="tag unread" title={`未読の返答 ${n} 件`}>
      未読 {n}
    </span>
  )
}
