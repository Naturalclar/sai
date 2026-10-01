/**
 * 返答の一部を選んだときに、選択のすぐ下に出す「引用して返信」（#604）。押すと返信欄の打ちかけの末尾に引用を足すだけで、送らない。
 * **押しても選択を外さない**（mousedown / pointerdown の既定の動作を止める。外れるとボタンごと消えて click が届かない）
 */
export function QuoteButton({ left, top, onQuote }: { left: number; top: number; onQuote: () => void }) {
  return (
    <button
      type="button"
      className="quote-btn"
      style={{ left, top }}
      title="選んだ所を引用として返信欄に入れる（送らない）"
      onPointerDown={(e) => e.preventDefault()}
      onMouseDown={(e) => e.preventDefault()}
      onClick={onQuote}
    >
      引用して返信
    </button>
  )
}
