// ⌘K の候補（フィードとセッション）の組み立てと絞り込み。DOM に依存しないので shared/palette.test.ts を
// node:test で回す。キーを受けて出すのは web/src/CommandPalette.tsx。
import { projectName } from './project.ts'
import type { SessionSummary } from './types.ts'

/** 候補 1 つ。先頭は必ずフィード */
export type PaletteItem =
  | { kind: 'feed'; label: string; hint: string }
  | {
      kind: 'session'
      id: string
      /** 表示名（付いていれば）、無ければ一覧のタイトル */
      label: string
      /** リポジトリ名 / ブランチ。左に小さく出す */
      hint: string
      icon?: string
      archived?: boolean
    }

/** フィードを表す候補。日本語と英語のどちらでも当たるように、検索対象には両方入れる */
const FEED_ITEM: Extract<PaletteItem, { kind: 'feed' }> = { kind: 'feed', label: 'フィード', hint: '全セッションを時系列に' }
/** フィードの検索対象（表示には出さない） */
const FEED_KEYS = 'フィード\nfeed\nすべて\nall'

/** 候補が飛ぶ先の hash */
export function paletteHash(item: PaletteItem): string {
  return item.kind === 'feed' ? '#/feed' : `#/s/${encodeURIComponent(item.id)}`
}

/**
 * 一覧から候補を作る。先頭は必ずフィードで、あとは一覧の並び（新しい順）のまま。
 * ラベルは表示名 → タイトル → `(無題)` の順（サイドバーの項目と同じ）
 */
export function paletteItems(sessions: readonly SessionSummary[]): PaletteItem[] {
  const out: PaletteItem[] = [FEED_ITEM]
  for (const s of sessions) {
    const project = projectName(s.project) || s.repo || ''
    const item: Extract<PaletteItem, { kind: 'session' }> = {
      kind: 'session',
      id: s.id,
      label: s.meta?.name || s.title || '(無題)',
      hint: [project, s.branch].filter(Boolean).join(' / '),
      }
    if (s.icon) item.icon = s.icon
    if (s.archived) item.archived = true
    out.push(item)
  }
  return out
}

/** 候補 1 つの検索対象。表示に出ないもの（ID、フィードの別名）も混ぜる */
function keysOf(item: PaletteItem): string {
  return item.kind === 'feed' ? FEED_KEYS : `${item.label}\n${item.hint}\n${item.id}`
}

/**
 * 検索語で絞る。空なら全部。小文字にして部分一致（`filterReplyTargets` / `filterSkills` と同じ規則）。
 * 空白で区切った語は **すべて** 当たったものだけ残す（`sai kanade` で絞れる）
 */
export function filterPalette(items: readonly PaletteItem[], query: string): PaletteItem[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean)
  if (words.length === 0) return [...items]
  return items.filter((item) => {
    const keys = keysOf(item).toLowerCase()
    return words.every((w) => keys.includes(w))
  })
}

/** ↑↓ で動かしたあとの位置。端では止まる（候補が無ければ 0） */
export function moveIndex(index: number, count: number, direction: 'prev' | 'next'): number {
  if (count <= 0) return 0
  const to = index + (direction === 'next' ? 1 : -1)
  return Math.max(0, Math.min(count - 1, to))
}
