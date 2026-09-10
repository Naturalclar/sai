// 発言の本文を舐めて探す（#230）。索引は持たず、store が持っているパース済みの行を filter するだけ。
//
// 当たりの判定と抜粋の切り出しは shared/search.ts（画面と同じ規則）。ここがやるのは
// 「どの行を対象にするか」と「セッションの名前を添えること」だけ。
import { entityId } from '../../shared/entity.ts'
import { projectName } from '../../shared/project.ts'
import { eventKind } from '../../shared/events.ts'
import { excerptOf, matchesAll, SEARCH_LIMIT } from '../../shared/search.ts'
import type { FeedRow, SearchHit, SessionSummary } from '../../shared/types.ts'

/**
 * 舐めるのは `text`（エージェントの返答）と `user_text`（自分の入力）だけ。
 *
 * **`thinking` は入れない。** 量は少ない（実測 6KB）が、あれは言ったことではなく考えたことなので、
 * 「言っていないこと」に当たってしまう。`/api/feed` でも行から落としている。
 * **待ちの行も入れない**（`text` が `許可待ち: Bash: …` という機械的な要約なので、検索の邪魔になる）
 */
function bodiesOf(row: FeedRow): { who: 'me' | 'agent'; body: string }[] {
  const out: { who: 'me' | 'agent'; body: string }[] = []
  const user = row.user_text?.trim()
  if (user) out.push({ who: 'me', body: user })
  const text = row.text?.trim()
  if (text && eventKind(row.event) === 'turn') out.push({ who: 'agent', body: text })
  return out
}

/**
 * 新しい順に上限まで。**アーカイブ済みも含める**（探しているのは見失ったものなので、
 * 除くと目的に反する。`/api/feed` が除いているのとはここが違う）。
 *
 * `sessions` は名前とアイコンを添えるためだけのもので、一覧に無くても当たりは落とさない
 * （その場合は `label` が ID になる）
 */
export function searchRows(
  rows: readonly FeedRow[],
  words: readonly string[],
  sessions: readonly SessionSummary[],
  limit = SEARCH_LIMIT,
): { hits: SearchHit[]; truncated: boolean } {
  if (words.length === 0) return { hits: [], truncated: false }
  const byId = new Map(sessions.map((s) => [s.id, s]))
  const hits: SearchHit[] = []
  let truncated = false
  // 新しい順に見て、上限に達したら残りは見ない（古い方を落とす）
  for (let i = rows.length - 1; i >= 0; i--) {
    const row = rows[i]!
    for (const { who, body } of bodiesOf(row)) {
      if (!matchesAll(body, words)) continue
      if (hits.length >= limit) return { hits, truncated: true }
      const id = entityId(row.session, row.repo, row.ts)
      const s = byId.get(id)
      const { text, hits: marks } = excerptOf(body, words)
      const hit: SearchHit = {
        id,
        ts: row.ts,
        who,
        label: s?.meta?.name || s?.title || id,
        hint: [projectName(s?.project ?? row.project ?? '') || row.repo, row.branch].filter(Boolean).join(' / '),
        excerpt: text,
        hits: marks,
      }
      if (s?.icon) hit.icon = s.icon
      if (s?.archived) hit.archived = true
      hits.push(hit)
    }
  }
  return { hits, truncated }
}
