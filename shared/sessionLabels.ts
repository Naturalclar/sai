// 同じ名前のセッションを見分ける添え字（#572）。表示名は自由に付けられるので、同じ project の中で同じ名前（題名）の
// セッションが 2 つ以上あると、要対応・サイドバー・`⌘K`・`@` の候補・通知で同じ顔になり、別のセッションを開いてしまう。
// **重なったときだけ**短い添え字を足す（重なっていなければ見た目を変えない）。リンクや返信先は今までどおり ID で引く。
// 添え字はサーバが一覧を組むときに 1 回だけ付け（`SessionSummary.label_suffix`）、名前を出す所は全部 `withSuffix()` を通す
// （別々に組み立てると、片方だけ区別が付かない）。DOM に依存しないので sessionLabels.test.ts を node:test で回す。
import { localDate } from './entity.ts'
import type { SessionSummary } from './types.ts'

type Labeled = Pick<SessionSummary, 'id' | 'title' | 'meta' | 'project' | 'repo' | 'start'>

/** 見分けに使う名前。表示名 → 題名 → ID（`sessionLabel()` と同じ順） */
function baseLabel(s: Pick<SessionSummary, 'id' | 'title' | 'meta'>): string {
  return s.meta?.name || s.title || s.id
}

/** 重なりを見る範囲。同じ project（無ければ worktree 名）の中だけ（要対応とフィードでは `#<project>` が隣に出ている） */
function scope(s: Pick<SessionSummary, 'project' | 'repo'>): string {
  return s.project || s.repo || ''
}

/** 同じ範囲で同じ名前のセッションの組（2 つ以上のものだけ）。ID の並びで返す */
export function labelCollisions(sessions: readonly Labeled[]): string[][] {
  const groups = new Map<string, string[]>()
  for (const s of sessions) {
    const key = `${scope(s)}\u0000${baseLabel(s)}`
    groups.set(key, [...(groups.get(key) ?? []), s.id])
  }
  return [...groups.values()].filter((ids) => ids.length > 1)
}

/** `2026-09-02` → `9/2〜` */
export function startLabel(ts: string): string {
  const day = ts ? localDate(ts) : ''
  const m = day.match(/^\d{4}-(\d{2})-(\d{2})$/)
  return m ? `${Number(m[1])}/${Number(m[2])}〜` : ''
}

/** ID の頭（セッションの部分）。組の中で重ならない長さまで伸ばす（4〜12 文字） */
function idHeads(ids: readonly string[]): Map<string, string> {
  const raw = ids.map((id) => id.split('@')[0] || id)
  for (let n = 4; n <= 12; n++) {
    const heads = raw.map((r) => r.slice(0, n))
    if (new Set(heads).size === heads.length) return new Map(ids.map((id, i) => [id, heads[i]!]))
  }
  return new Map(ids.map((id, i) => [id, raw[i]!]))
}

/**
 * 添え字（ID → 添え字）。重なっていないセッションは入れない。
 * 第一候補は**始まった日**（`9/2〜`。人が読める）で、組の中で日が重なる（か分からない）ものは **ID の頭**（`a3d0`）にする。
 * `startOf` はそのセッションの本当の始まり（一覧の `start` は窓の中の最初の行なので、窓が狭いと本当の始まりより遅い）。
 * 無ければ `start` を使う
 */
export function labelSuffixes(sessions: readonly Labeled[], startOf: (id: string) => string = () => ''): Map<string, string> {
  const byId = new Map(sessions.map((s) => [s.id, s]))
  const out = new Map<string, string>()
  for (const ids of labelCollisions(sessions)) {
    const days = ids.map((id) => startLabel(startOf(id) || byId.get(id)?.start || ''))
    const unique = days.every((d, i) => d && days.indexOf(d) === i)
    if (unique) {
      ids.forEach((id, i) => out.set(id, days[i]!))
      continue
    }
    // 日だけでは分けられないもの（同じ日に始まった・日が取れない）は ID の頭。分けられるものは日のまま
    const clash = ids.filter((_, i) => !days[i] || days.filter((d) => d === days[i]).length > 1)
    const heads = idHeads(clash)
    ids.forEach((id, i) => out.set(id, heads.get(id) ?? days[i]!))
  }
  return out
}

/** 名前に添え字を足す（添え字が無ければそのまま）。名前を出す所は全部これを通す */
export function withSuffix(label: string, s: Pick<SessionSummary, 'label_suffix'> | null | undefined): string {
  return s?.label_suffix ? `${label}（${s.label_suffix}）` : label
}

/**
 * 名前を付けるときの知らせ（#572）。同じ範囲の、アーカイブ済みでないほかのセッションに同じ表示名があれば、その 1 つ。
 * **止めはしない**（同じ名前にしたいこともある）
 */
export function sameNamed<T extends Pick<SessionSummary, 'id' | 'meta' | 'project' | 'repo' | 'archived'>>(
  sessions: readonly T[],
  self: Pick<SessionSummary, 'id' | 'project' | 'repo'>,
  name: string,
): T | null {
  const want = name.trim()
  if (!want) return null
  return sessions.find((s) => s.id !== self.id && !s.archived && scope(s) === scope(self) && s.meta?.name === want) ?? null
}

/** 名前を付けるときの知らせの文（`同じ名前のセッションがあります（9/2〜、285 ターン）`） */
export function sameNameNote(twin: Pick<SessionSummary, 'start' | 'turns'>): string {
  const parts = [startLabel(twin.start), `${twin.turns} ターン`].filter(Boolean)
  return `同じ名前のセッションがあります（${parts.join('、')}）。一覧・要対応では添え字で見分けます`
}
