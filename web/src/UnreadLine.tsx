/** 「ここから未読」の線（#502）。日付の区切りと同じ形で、前回読んだところの次の返答の前に引く */
export function UnreadLine() {
  return (
    <div className="day unread-line" role="separator" aria-label="ここから未読">
      <span>ここから未読</span>
    </div>
  )
}
