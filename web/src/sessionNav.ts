// サイドバーのセッションをキーボードで移動するためのロジック。DOM に依存しないので sessionNav.test.ts を node:test で回す。
// キーを受けるのは App.tsx（window の keydown）、選択項目を見えるところまで動かすのは SessionItem.tsx。

/** キー入力がセッション移動のどれに当たるか。修飾キー付きと IME 変換中は何もしない */
export type NavAction = 'prev' | 'next' | 'feed'

interface KeyLike {
  key: string
  metaKey: boolean
  ctrlKey: boolean
  altKey: boolean
  shiftKey: boolean
  isComposing: boolean
}

/**
 * ↑ / k で1つ上（新しい方）、↓ / j で1つ下（古い方）、Esc でフィードへ。
 * j / k は vim 風。修飾キーが1つでも押されていれば null（⌘↑ や Shift+j をブラウザやアプリに残す）
 */
export function navAction(e: KeyLike): NavAction | null {
  if (e.isComposing || e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return null
  if (e.key === 'ArrowUp' || e.key === 'k') return 'prev'
  if (e.key === 'ArrowDown' || e.key === 'j') return 'next'
  if (e.key === 'Escape') return 'feed'
  return null
}

/** キーが向いているのが文字入力（input / textarea / select / contentEditable）なら、そちらに任せてセッションは動かさない */
export function isTypingTarget(target: { tagName?: string; isContentEditable?: boolean } | null): boolean {
  if (!target) return false
  const tag = (target.tagName ?? '').toUpperCase()
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable === true
}

/**
 * 一覧の並び（サイドバーに出ている順）で隣のセッションID。
 * 起点は「いま開いているセッション」。一覧に無ければ（フィードを見ている、絞り込みで隠れた）先頭。端では null
 */
export function neighborSessionId(ids: readonly string[], currentId: string | null, direction: 'prev' | 'next'): string | null {
  if (ids.length === 0) return null
  const at = currentId === null ? -1 : ids.indexOf(currentId)
  if (at < 0) return ids[0] ?? null
  const to = at + (direction === 'next' ? 1 : -1)
  if (to < 0 || to >= ids.length) return null
  return ids[to] ?? null
}
