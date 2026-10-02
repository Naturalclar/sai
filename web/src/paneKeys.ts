// ペインをキーボードで分ける・移る・閉じる（#633）。判定だけを純粋関数にして node:test で回す（sessionNav.ts と同じ形）。
// キーを受けるのは App.tsx（window の keydown）。tmux に寄せてある: `%` で左右に分ける（`"` は上下のために空けておく）。
import { MAX_COLUMNS } from './paneLayout.ts'

export type PaneKey =
  /** `%`: 横に分ける */
  | { kind: 'split' }
  /** `h` / `l`: 左 / 右のペインへ */
  | { kind: 'move'; by: -1 | 1 }
  /** `x`: フォーカスのあるペインを閉じる */
  | { kind: 'close' }
  /** `Ctrl+1` 〜: 左から数えた番号のペインの入力欄へ（`index` は 0 始まり）。**入力中でも効く** */
  | { kind: 'focus'; index: number }

interface KeyLike {
  key: string
  metaKey: boolean
  ctrlKey: boolean
  altKey: boolean
  shiftKey: boolean
  isComposing: boolean
}

/**
 * キー入力がペインの操作のどれに当たるか。IME 変換中は何もしない。
 * - `%` は Shift を伴う配列が多い（US は Shift+5）ので、Shift は見ない。`h` `l` `x` は修飾キーが 1 つでもあれば null
 *   （⌘L や Ctrl+H をブラウザに残す）
 * - `typing`（入力欄で打っている）のときは `Ctrl+数字` だけ（`%` `h` `l` `x` は文字として入る）
 * - `Ctrl+数字` は Ctrl だけ（⌘+数字はブラウザのタブの切り替え）
 */
export function paneKey(e: KeyLike, typing: boolean): PaneKey | null {
  if (e.isComposing) return null
  if (e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey && /^[1-9]$/.test(e.key)) {
    const index = Number(e.key) - 1
    return index < MAX_COLUMNS ? { kind: 'focus', index } : null
  }
  if (typing || e.metaKey || e.ctrlKey || e.altKey) return null
  if (e.key === '%') return { kind: 'split' }
  if (e.shiftKey) return null
  if (e.key === 'h') return { kind: 'move', by: -1 }
  if (e.key === 'l') return { kind: 'move', by: 1 }
  if (e.key === 'x') return { kind: 'close' }
  return null
}
