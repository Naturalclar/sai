interface Props {
  /** ボタンに出す続き（1 行に直して長さで切ってある。`replySuggest.ts` の `suggestionLabel()`） */
  label: string
  onAccept: () => void
}

/**
 * 打ちかけの続き（#219）を**タップで**受け取るボタン（#349）。ソフトキーボードには矢印キーが無く `→` を押せないので、
 * タッチ端末のときだけ入力欄の上に出す（出すかどうかは `ReplyBox` が決める。キーボードの `→` は今までどおり）。
 * 押しても入力欄のフォーカスは奪わない（mousedown を止める。フィードの返信先チップ #297 と同じ）
 */
export function SuggestionChip({ label, onAccept }: Props) {
  return (
    <div className="suggest">
      <button
        type="button"
        className="accept"
        onMouseDown={(e) => e.preventDefault()}
        onClick={onAccept}
        title="前に送った文の続きを入れる"
        aria-label={`続きを入れる: ${label}`}
      >
        <span className="mark" aria-hidden="true">▸</span>
        <span className="rest">{label}</span>
      </button>
    </div>
  )
}
