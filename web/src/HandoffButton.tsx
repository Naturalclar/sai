import { useState } from 'react'

/**
 * 「引き継いで新しいセッション」（#442）。押すと、このセッションに引き継ぎを書かせる 1 ターンを送る。
 * 1 ターン使うので、押し間違いで送らないように 1 回確かめる。書けたら入力欄の下に「この引き継ぎで始める」が出る
 */
export function HandoffButton({ onHandoff }: { onHandoff: () => void }) {
  const [asking, setAsking] = useState(false)
  if (!asking) {
    return (
      <span className="meta">
        <button type="button" className="linkish" onClick={() => setAsking(true)} title="このセッションに引き継ぎを書かせ、それを最初の入力にして新しいセッションを始める。前のセッションは消さない・アーカイブしない">
          引き継いで新しいセッション
        </button>
      </span>
    )
  }
  return (
    <span className="meta handoff-ask">
      引き継ぎを書かせますか？（1 ターン使います）
      <button type="button" className="linkish" onClick={() => { setAsking(false); onHandoff() }}>書かせる</button>
      <button type="button" className="linkish" onClick={() => setAsking(false)}>やめる</button>
    </span>
  )
}
