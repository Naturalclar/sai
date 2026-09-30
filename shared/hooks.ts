// Claude Code のフックの配線のずれ（#567）。あるべき一覧と `settings.json` の `hooks` を突き合わせる。
// フックを足しても手元の設定が追従していないことに、行からは気づけない（`SessionEnd` は `/clear`・`/exit` でしか
// 書かれないので「行が無い」は「繋がっていない」の証拠にならない）。サーバ（画面のバナー）と `/setup-sai` が同じ判定を使う。
// DOM にも fs にも依存しない（「このコマンドは record.py に届くか」は呼ぶ側が関数で渡す）ので hooks.test.ts を node:test で回す。

/** あるべきフック 1 つ。`matcher` が空なら matcher 無し（全部に当たる）で繋ぐ */
export interface ExpectedHook {
  event: string
  matcher: string
}

/**
 * `record.py` に届いていてほしい Claude Code のフック。**README「1. フックを向ける」の JSON の例と同じ**
 * （`server/docs.test.ts` が突き合わせる。足したら両方に足す）。
 * `Stop` だけでもターンは記録されるが、残りが欠けると待ち・入力・会話の区切りが出ない
 */
export const EXPECTED_CLAUDE_HOOKS: readonly ExpectedHook[] = [
  { event: 'Stop', matcher: '' },
  { event: 'PermissionRequest', matcher: '' },
  { event: 'PreToolUse', matcher: 'AskUserQuestion|ExitPlanMode' },
  { event: 'Notification', matcher: 'idle_prompt|agent_needs_input|elicitation_dialog|elicitation_url_dialog|permission_prompt' },
  { event: 'UserPromptSubmit', matcher: '' },
  { event: 'SessionEnd', matcher: '' },
]

/** 足りないもの 1 つ。`missing` は届くフックがそのイベントに無い、`matcher` はあるが当たらない値がある */
export interface HookGap {
  event: string
  kind: 'missing' | 'matcher'
  /** `matcher` のとき、当たっていない値（`idle_prompt` など） */
  uncovered: string[]
}

/** そのコマンドが `record.py` に届くか。直書きか、PATH のラッパーの中身が呼ぶか（呼ぶ側が決める） */
export type ReachesRecord = (command: string) => boolean

interface HookGroup {
  matcher?: unknown
  hooks?: unknown
}

/** matcher 無し・`*` は全部に当たる */
function matchesAll(matcher: string): boolean {
  return matcher === '' || matcher === '*'
}

/** `A|B` を値の集合に（正規表現として読めないときの落としどころ） */
function alternatives(matcher: string): string[] {
  return matcher
    .split('|')
    .map((s) => s.trim())
    .filter(Boolean)
}

/**
 * その matcher が値に当たるか。**Claude Code の matcher は正規表現**なので（`.*`・`idle_.*` のように書ける。#569 のレビュー）、
 * 全体に当たるかを正規表現で見る。正規表現として読めなければ、`|` で並べた名前の一致に落とす
 */
function matcherHits(matcher: string, value: string): boolean {
  if (matchesAll(matcher)) return true
  try {
    return new RegExp(`^(?:${matcher})$`).test(value)
  } catch {
    return alternatives(matcher).includes(value)
  }
}

/** 名前を問わず当たる matcher か（matcher 無しで繋ぐべきイベントに付いていても、全部に当たるなら足りている） */
const ANY_PROBES = ['Bash', 'x', '__sai_probe__']
function matchesAnything(matcher: string): boolean {
  return ANY_PROBES.every((v) => matcherHits(matcher, v))
}

/**
 * 設定（`settings.json` の中身。いくつ渡してもよい。ユーザーとプロジェクトなど）から、あるべきフックのうち
 * `record.py` に届いていないものを返す。
 *
 * **届くフックが 1 つも無ければ `null`（分からない）**: ラッパーが PATH で引けない・プロジェクト側や別の置き場で
 * 繋いでいる、のように「届いているのに見えていない」ことがあるので、そのときは何も言わない（全部足りないと決めつけない）。
 * 全部揃っていれば空の配列。
 */
export function claudeHookGaps(settings: readonly unknown[], reaches: ReachesRecord, expected: readonly ExpectedHook[] = EXPECTED_CLAUDE_HOOKS): HookGap[] | null {
  // イベント → record.py に届くグループの matcher（重なっていてよい）
  const reached = new Map<string, string[]>()
  for (const s of settings) {
    const hooks = s && typeof s === 'object' ? (s as { hooks?: unknown }).hooks : undefined
    if (!hooks || typeof hooks !== 'object' || Array.isArray(hooks)) continue
    for (const [event, groups] of Object.entries(hooks as Record<string, unknown>)) {
      if (!Array.isArray(groups)) continue
      for (const g of groups as HookGroup[]) {
        const list = g && Array.isArray(g.hooks) ? (g.hooks as unknown[]) : []
        const hit = list.some((h) => {
          const cmd = h && typeof h === 'object' ? (h as { command?: unknown }).command : undefined
          return typeof cmd === 'string' && reaches(cmd)
        })
        if (!hit) continue
        const matcher = typeof g.matcher === 'string' ? g.matcher.trim() : ''
        reached.set(event, [...(reached.get(event) ?? []), matcher])
      }
    }
  }
  if (reached.size === 0) return null

  const gaps: HookGap[] = []
  for (const want of expected) {
    const matchers = reached.get(want.event)
    if (!matchers) {
      gaps.push({ event: want.event, kind: 'missing', uncovered: [] })
      continue
    }
    if (matchers.some(matchesAnything)) continue
    // matcher 無しで繋ぐべきものが、特定の値の matcher でだけ繋がっている
    if (!want.matcher) {
      gaps.push({ event: want.event, kind: 'matcher', uncovered: [] })
      continue
    }
    // あるべき値のそれぞれに、どれかの塊の matcher が当たるか（複数の塊は合わせて見る）
    const uncovered = alternatives(want.matcher).filter((v) => !matchers.some((m) => matcherHits(m, v)))
    if (uncovered.length > 0) gaps.push({ event: want.event, kind: 'matcher', uncovered })
  }
  return gaps
}

/** 画面・スキルに出す 1 行（`SessionEnd` / `Notification（matcher に idle_prompt が無い）`） */
export function hookGapLabel(gap: HookGap): string {
  if (gap.kind === 'missing') return gap.event
  if (gap.uncovered.length === 0) return `${gap.event}（matcher が絞られている）`
  return `${gap.event}（matcher に ${gap.uncovered.join(' / ')} が無い）`
}
