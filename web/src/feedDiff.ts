// フィードのバブルから差分を開く（#280）。どのセッションの行数と PR 番号を取りに行くか、どのバブルにボタンを出すか、
// 差分をどの画面で出したままにするか。DOM 非依存なので feedDiff.test.ts を node:test で回す。
import { entityId } from '../../shared/entity.ts'
import { eventKind } from '../../shared/events.ts'
import { isRemoteHost } from '../../shared/host.ts'
import { refsIn } from '../../shared/refs.ts'
import type { FeedRow, SessionDiffSummaryResponse } from '../../shared/types.ts'

/** バブルに差分のボタンを出すために `Chat` へ渡すもの */
export interface ChatDiffs {
  /** エンティティID → 行数と PR 番号（`useDiffSummaries`）。取れたものだけ */
  summaries: ReadonlyMap<string, SessionDiffSummaryResponse>
  /** いま差分を出しているエンティティID */
  open: string | null
  onToggle: (id: string) => void
}

/**
 * 行数と PR 番号（`?summary=1`）を取りに行くセッションと、取り直しの目印（最後のターン完了の `ts`）。
 *
 * **ターン完了の本文にそのリポジトリの番号（`#N` / `owner/repo#N` / `<remote>/pull/N`）が出てくるセッションだけ。**
 * PR に触れていないセッションに `gh pr view` まで叩きに行かない（手元の 3 日ぶんで 17 セッション中 8 つ）。
 * 別のマシンの行は、ここの git では読めないので見ない（#114）。セッションが取れない行も、cwd が混ざるので見ない。
 * 目印は番号に触れた行ではなく**最後のターン完了**のもの（そのあとのターンでブランチや PR が変わる）
 */
export function prStamps(rows: readonly FeedRow[], selfHost: string): Map<string, string> {
  const last = new Map<string, string>()
  const mentioned = new Set<string>()
  for (const r of rows) {
    if (eventKind(r.event) !== 'turn' || !r.session || isRemoteHost(r.host, selfHost)) continue
    const id = entityId(r.session, r.repo, r.ts)
    if ((last.get(id) ?? '') < r.ts) last.set(id, r.ts)
    if (!mentioned.has(id) && [...refsIn(r.text ?? '', r.remote)].some((key) => key.startsWith('#'))) mentioned.add(id)
  }
  const out = new Map<string, string>()
  for (const id of mentioned) out.set(id, last.get(id) ?? '')
  return out
}

/**
 * このバブルに差分のボタンを出すか。**本文がそのセッションのいまのブランチの PR の番号に触れているときだけ。**
 *
 * 差分ビューアが出すのは worktree の**いまの**差分で、返信した時点のものではない。worktree を使い回して
 * PR を何本も出すセッションが普通なので（手元では 8 セッション中 7 つが 5〜16 本）、古い PR の番号に触れた
 * バブルにも出すと、押したときに別のブランチの差分が出る。GitHub は issue と PR で番号を共有するので、
 * 裸の `#N` が PR の番号と一致すればその PR。差分の中身が無ければ（ファイルも追跡外も 0）開いても空なので出さない
 */
export function opensDiff(text: string, remote: string | undefined, summary: SessionDiffSummaryResponse | undefined): boolean {
  if (!summary?.pr) return false
  if (summary.files === 0 && summary.untracked === 0) return false
  return refsIn(text, remote).has(`#${summary.pr.number}`)
}

/** どこから差分を開いたか。入力欄のボタンなら `session`、フィードのバブルなら `feed` */
export type DiffOrigin = 'session' | 'feed'

export interface OpenDiff {
  id: string
  origin: DiffOrigin
}

/**
 * いま差分を出すエンティティID（出さなければ null）。
 *
 * - そのセッションを開いていれば、どこから開いたものでも出す
 * - フィードから開いたものは、フィードにいる間も出す。**セッションで開いたものはフィードでは出さない**（今までどおり）
 * - 別のセッションへ移っている間は出さない（閉じるまで覚えておき、戻ってくれば出る）
 * - 狭い画面の `#/` は一覧だけでフィードが見えていないので、モーダルを重ねない
 */
export function visibleDiff(diff: OpenDiff | null, route: { name: string; id?: string }, narrow: boolean): string | null {
  if (!diff) return null
  if (route.name === 'session') return route.id === diff.id ? diff.id : null
  if (diff.origin !== 'feed') return null
  return route.name === 'feed' || (route.name === 'list' && !narrow) ? diff.id : null
}

/**
 * ボタンを押したあとの状態。トグルは「**いま出ているか**」で決める。覚えているだけで出ていない
 * （セッションで開いたままフィードに来た）ものを押して閉じてしまうと、1 回目の押下が空振りになる
 */
export function nextDiff(visible: string | null, id: string, origin: DiffOrigin): OpenDiff | null {
  return visible === id ? null : { id, origin }
}
