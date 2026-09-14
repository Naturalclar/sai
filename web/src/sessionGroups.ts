// サイドバーのセッション一覧を、リポジトリごとの塊にまとめる（#364）。DOM に触らないので node:test で回す（sessionGroups.test.ts）。
//
// **画面の並びとキーボードの `↑↓` の並びは、必ずここから作る**（`App.tsx` が `visibleIds()` を `navTarget()` に渡す）。
// 別々に組み立てると、畳んで見えていないセッションに `↑↓` で移ってしまう。
import { projectName } from '../../shared/project.ts'
import type { SessionSummary } from './api'

/** どのリポジトリか分からないセッション（origin の無い worktree など）の塊 */
export const OTHER_KEY = ''
export const OTHER_LABEL = 'その他'

export interface SessionGroup {
  /** `project`（`Naturalclar/sai`）。分からなければ空 */
  key: string
  /** 見出しに出す名前（`projectName()` の最後の区切り。空なら「その他」） */
  label: string
  /** そのリポジトリのセッション（渡された順のまま = 新しい順） */
  sessions: SessionSummary[]
  /** 中にいくつ「要対応」があるか。**畳んでいても見出しに出す**（畳んで見落とさないように） */
  todo: number
}

/**
 * リポジトリ（`project`）ごとにまとめる。**塊の順は「中で一番新しいセッション」の順**で、
 * 渡された一覧が新しい順（`aggregate.ts` が `end` の降順）なので、**最初に出てきた順**がそのままそれになる。
 * 塊の中も渡された順のまま。
 *
 * **塊が 1 つでも見出しは出す**（画面側の判断。ここは常に塊を返す）
 */
export function sessionGroups(sessions: readonly SessionSummary[], waiting: ReadonlySet<string> = new Set()): SessionGroup[] {
  const groups: SessionGroup[] = []
  const byKey = new Map<string, SessionGroup>()
  for (const s of sessions) {
    const key = s.project || OTHER_KEY
    let group = byKey.get(key)
    if (!group) {
      group = { key, label: key ? projectName(key) || key : OTHER_LABEL, sessions: [], todo: 0 }
      byKey.set(key, group)
      groups.push(group)
    }
    group.sessions.push(s)
    if (waiting.has(s.id)) group.todo++
  }
  return groups
}

/** その塊を畳んでいるか */
export function isCollapsed(collapsed: readonly string[], key: string): boolean {
  return collapsed.includes(key)
}

/**
 * 畳む・開く。**覚えるのは畳んだものだけ**（開いているのが既定なので、新しいリポジトリのセッションが
 * 増えても勝手に畳まれない）
 */
export function toggleCollapsed(collapsed: readonly string[], key: string): string[] {
  return isCollapsed(collapsed, key) ? collapsed.filter((k) => k !== key) : [...collapsed, key]
}

/** いま画面に出ているセッションの id（畳んだ塊の中は入らない）。`↑↓` の行き先はこれで決める */
export function visibleIds(groups: readonly SessionGroup[], collapsed: readonly string[]): string[] {
  return groups.flatMap((g) => (isCollapsed(collapsed, g.key) ? [] : g.sessions.map((s) => s.id)))
}
