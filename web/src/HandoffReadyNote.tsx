import { useState } from 'react'

/**
 * 入力欄の下の 1 行（#442）。最後のターンが引き継ぎの返答のときに出る。押すと、その返答を最初の入力にして新しいセッションを始める。
 * 始める前に引き継ぎを読める（足りなければ普通に返信して直させ、もう一度「引き継いで新しいセッション」を押す）
 */
export function HandoffReadyNote({ onStart }: { onStart: () => Promise<boolean> }) {
  const [busy, setBusy] = useState(false)
  const start = () => {
    setBusy(true)
    void onStart().finally(() => setBusy(false))
  }
  return (
    <div className="notice archive-return handoff-ready" role="status">
      <span>引き継ぎが書けました。</span>
      <button type="button" onClick={start} disabled={busy}>この引き継ぎで新しいセッションを始める</button>
      <span>（足りなければ、返信して直させてからもう一度引き継ぐ）</span>
    </div>
  )
}
