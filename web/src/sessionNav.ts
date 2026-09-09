// サイドバーのセッションをキーボードで移動するためのロジック。DOM に依存しないので sessionNav.test.ts を node:test で回す。
// キーを受けるのは App.tsx（window の keydown）、選択項目を見えるところまで動かすのは SessionItem.tsx と SessionList.tsx（フィードの項目）。

/** キー入力がセッション移動のどれに当たるか。修飾キー付きと IME 変換中は何もしない */
export type NavAction = 'prev' | 'next' | 'feed' | 'input'

interface KeyLike {
  key: string
  metaKey: boolean
  ctrlKey: boolean
  altKey: boolean
  shiftKey: boolean
  isComposing: boolean
}

/**
 * ↑ / k で1つ上（新しい方）、↓ / j で1つ下（古い方）、Esc でフィードへ、→ で返信の入力欄へ。
 * j / k は vim 風。修飾キーが1つでも押されていれば null（⌘↑ や Shift+j をブラウザやアプリに残す）。
 * 入力欄から一覧へ戻る ← は入力欄しか本文の中身を知らないので、こちらではなく `replyFocus.ts` にある
 */
export function navAction(e: KeyLike): NavAction | null {
  if (e.isComposing || e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return null
  if (e.key === 'ArrowUp' || e.key === 'k') return 'prev'
  if (e.key === 'ArrowDown' || e.key === 'j') return 'next'
  if (e.key === 'ArrowRight') return 'input'
  if (e.key === 'Escape') return 'feed'
  return null
}

/** キーが向いているのが文字入力（input / textarea / select / contentEditable）なら、そちらに任せてセッションは動かさない */
export function isTypingTarget(target: { tagName?: string; isContentEditable?: boolean } | null): boolean {
  if (!target) return false
  const tag = (target.tagName ?? '').toUpperCase()
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable === true
}

/** 移動の行き先＝サイドバーの項目。固定の「フィード」「要対応」がセッションより上に並ぶ */
export type NavTarget = { kind: 'feed' } | { kind: 'todo' } | { kind: 'session'; id: string }

/** サイドバーの固定項目（見た目の並びと同じ順）。セッションはこの後ろ */
const PINNED: NavTarget[] = [{ kind: 'feed' }, { kind: 'todo' }]

const same = (a: NavTarget, b: NavTarget) => a.kind === b.kind && (a.kind !== 'session' || a.id === (b as { id: string }).id)

/**
 * 一覧の並び（サイドバーに出ている順）で隣へ。**固定項目（フィード → 要対応）をセッションより上として扱う**ので、
 * 一番上のセッションで prev は「要対応」に行き、フィードで prev は止まる（サイドバーの見た目と同じ順序）。
 * 端では null で、呼び出し側は何もしない。
 * 開いているセッションが一覧に無いとき（絞り込みで隠れた）は、今までどおり先頭のセッションへ
 */
export function navTarget(ids: readonly string[], from: NavTarget, direction: 'prev' | 'next'): NavTarget | null {
  const all: NavTarget[] = [...PINNED, ...ids.map((id): NavTarget => ({ kind: 'session', id }))]
  const at = all.findIndex((t) => same(t, from))
  // 一覧に無いセッションを開いている（絞り込みで隠れた）。どちらのキーでも先頭のセッションへ
  if (at < 0) {
    const first = ids[0]
    return first === undefined ? null : { kind: 'session', id: first }
  }
  return all[at + (direction === 'next' ? 1 : -1)] ?? null
}
