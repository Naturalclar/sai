/**
 * セッション画面の先頭に置く「前の 7 日を表示」（#477）。詳細の API は直近のぶんだけ返すので、それより前の行は
 * 押したときだけ取る。`count` はまだ描いていない行の数（窓の中）
 */
export function OlderRowsButton({ count, days, onMore }: { count: number; days: number; onMore: () => void }) {
  return (
    <div className="older-rows">
      <button type="button" onClick={onMore}>前の {days} 日を表示（残り {count} 件）</button>
    </div>
  )
}
