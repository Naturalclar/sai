// セッション同士のメッセージ（#310 / #311）。SAI の MCP サーバのツール（sai_sessions / sai_send / sai_wait）と
// SAI サーバが同じ規則を見る。DOM にもファイルにも触らないので shared/agentMessages.test.ts で回す
import { isCompactSummaryText } from './compactSummary.ts'
import { entityId } from './entity.ts'
import { isLoopPrompt } from './loops.ts'
import { isWaitPrompt } from './waits.ts'
import { replyBlockedReason } from './reply.ts'
import { promptTracker } from './turnPrompts.ts'
import { mayCross } from './sendAcross.ts'
import type { Agent, AgentSessionEntry, FeedRow, SendAcrossPair, SessionSummary, UsageResponse, UsageWindow } from './types.ts'

/**
 * 1 回のターンで sai_send を呼べる回数（#311 の往復の上限。仮の既定）。
 * 送るたびに相手は自分の長い会話を丸ごと読み直す（手元の実測で 1 ターン 60 万〜926 万トークン）ので、回数で縛る
 */
export const AGENT_SEND_MAX = 3
/** sai_wait が返す相手の返答の最大文字数（#311。送り元の会話を膨らませない。record.py が text を 2000 字で切るので、今はそれより大きい） */
export const AGENT_REPLY_MAX_CHARS = 4000
/** sai_send で送れる本文の上限 */
export const AGENT_TEXT_MAX_CHARS = 4000
/** sai_sessions の一覧に載せる最後の発言の長さ（本文は載せない） */
const LAST_TEXT_CHARS = 120
/**
 * 相手のエージェントの 5 時間の枠がここまで使われていたら送らない（#311。仮の既定）。
 * 週の枠は長いので、ほぼ使い切ったときだけ止める
 */
export const AGENT_USAGE_STOP_PERCENT = 80
export const AGENT_WEEKLY_STOP_PERCENT = 95
/**
 * 1 ターンで相手に読み直させてよい量（トークン。#311。仮の既定）。送るたびに相手の会話の大きさ（直近の呼び出しの入力）を足し、
 * 超えるなら送らない。手元の長いセッションは 1 回の呼び出しで 90 万トークン近く読んでいた
 */
export const AGENT_TURN_READ_BUDGET = 3_000_000
/**
 * 依頼 1 つ（送り元の 1 ターンで頼んだ分。もう送った分 + 預かっている分）で送れる数（#727。仮の既定）。
 * 1 ターンの回数（`AGENT_SEND_MAX`）を超えた分は断らずに預かり、送り元のターンが終わってから順に送る。その合計の上限
 */
export const AGENT_REQUEST_MAX = 8
/**
 * 依頼 1 つで相手に読み直させてよい量の合計（トークン。#727。仮の既定）。**預かる前に数え**、超えるなら 1 件も預からずに断る。
 * 1 ターンの予算（`AGENT_TURN_READ_BUDGET`）の 2 倍に置いてある
 */
export const AGENT_REQUEST_READ_BUDGET = 6_000_000
/** 預かった分を送る 1 巡と次の 1 巡の間（ミリ秒。#727。仮の既定）。1 巡で送るのは `AGENT_SEND_MAX` 件・`AGENT_TURN_READ_BUDGET` まで */
export const AGENT_BACKLOG_ROUND_MS = 60_000

/** 見出しの書き出し。人が打った入力と見分けるための印 */
export const AGENT_HEADER_MARK = '【SAI】'

/**
 * 見出しの「返答はどこへ行くか」（#588）。**送り元が待っていないこともある**ので「送り元に返ります」とは言い切らない
 * （待たずにターンを終えた送り元には、返答は画面にしか出ない）
 */
export const REPLY_NOTE = 'このターンの最後の発言が返答として送り元の画面に出て、送り元の次のターンの頭にも届きます（送り元が sai_wait で待っていれば、その場で受け取ります）。'

/**
 * 相手に届ける文。見出しの 1 行で「人ではなく別のセッションから」「返答はこのターンの最後の発言」を伝える。
 * 画面では受け取った側の自分バブルにそのまま出るので、誰から来たかも見える。
 * **見出しに message_id を入れる**: record.py は `user_text` を 2000 字で切るので、本文の一致ではどのターンか決められない
 */
export function deliveredText(from: { label: string; project: string }, messageId: string, text: string): string {
  return `${AGENT_HEADER_MARK}#${from.project} の「${from.label}」からのメッセージです（id: ${messageId}）。${REPLY_NOTE}\n\n${text.trim()}`
}

/**
 * tailnet の MCP（`/mcp`。#312）から送るときの見出し。送り元はセッションではなく、呼んだ人（ログイン名）かタグ付きの端末。
 * 印と id の形は `deliveredText()` と同じにして、`isDeliveryOf()` / `replyOf()` がそのまま返答を探せるようにする
 */
export function deliveredFromTailnet(caller: string, messageId: string, text: string): string {
  return `${AGENT_HEADER_MARK}tailnet の「${caller}」からのメッセージです（id: ${messageId}）。このターンの最後の発言が送り元に返ります（送り元が sai_wait で待っているとき）。\n\n${text.trim()}`
}

/** 見出しの id を取り出す。届けた文でなければ空（#588） */
export function deliveredId(userText: string | undefined): string {
  const head = (userText ?? '').trimStart().slice(0, 400)
  if (!head.startsWith(AGENT_HEADER_MARK)) return ''
  return /（id: ([0-9a-f]+)）/.exec(head)?.[1] ?? ''
}

/**
 * ターン完了の行が、どのメッセージで回ったターンのものかを引く道具（#626）。行を**古い順**に `headOf()` へ渡すと、
 * ターン完了の行なら「そのターンの入力」（見出しを探す文）を返す。ターン完了でない行は空。
 *
 * ふつうはターン完了の行の `user_text` の見出しで分かる。**ターンの途中で自動の要約が走った行は `user_text` が要約の文に
 * 置き換わっていて見出しが無い**（記録の側は直したが、もう書かれた行は残る）ので、そのときだけ**同じセッションの直前の
 * 入力した瞬間の行（`UserPromptSubmit`）の見出し**で当てる。
 * - 救うのは `user_text` が要約の行だけ（入力が空のターン = バックグラウンドの通知で回ったターンなどには当てない）
 * - 入力の行の見出しは、次のターン完了の行 1 つにだけ使う（別のターンの返答を当てない）
 * - **そのターンが終わったと分かる行（`入力待ち`・セッションの終了）が来たら見出しを捨てる**（#661 のレビュー）。届けたターンの
 *   ターン完了の行が落ちたまま、あとの「入力の行が無く、入力が要約になっている」ターンを返答に当てないため。
 *   `入力待ち` が鳴らない道（`-p` の返信）で落ちたターンは、落ちた返答を補った行（`rowsNow()`。#614）がターン完了として見出しを使う
 */
export function deliveryMatcher(): { headOf: (row: FeedRow) => string } {
  // 入力の行を覚える・捨てる規則は `promptTracker()`（記録を調べる道具の `pairTurns()` と同じもの。#703）
  const tracker = promptTracker()
  return {
    headOf(row) {
      const step = tracker.step(row)
      if (!step?.turn) return ''
      return isCompactSummaryText(row.user_text) ? (step.prompt?.user_text ?? '') : (row.user_text ?? '')
    },
  }
}

/**
 * 送ったメッセージへの返答の行（#588）。送り元が `sai_wait` せずにターンを終えると、返答は相手のセッションにしか無く、
 * 送り元の会話は「頼みました」で止まって見える。そこで**送り元の画面に並べる**ために、相手のターン完了の行に印を付けて返す。
 * 行は 1 回だけ舐める（メッセージごとに `replyOf()` を呼ぶと、3 秒のポーリングのたびに 送った数 × 行 になる）。
 * 相手が違う行（見出しを写しただけの行）は数えない。古い順。`rows` も古い順で渡す（`deliveryMatcher()` が直前の入力の行を見る）
 */
export function agentReplyRows(
  sent: readonly { message_id: string; to: string; since: string; handed_at?: string }[],
  rows: readonly FeedRow[],
  toName: (id: string) => string,
  /** 相手のアイコンの URL（#666）。付けていなければ空・undefined で、印には載せない */
  toIcon: (id: string) => string | undefined = () => undefined,
): FeedRow[] {
  const want = new Map(sent.map((m) => [m.message_id, m]))
  if (want.size === 0) return []
  const out: FeedRow[] = []
  const seen = new Set<string>()
  const matcher = deliveryMatcher()
  for (const r of rows) {
    const id = deliveredId(matcher.headOf(r))
    const m = id ? want.get(id) : undefined
    if (!m || seen.has(id)) continue
    if (entityId(r.session ?? '', r.repo ?? '', String(r.ts ?? '')) !== m.to) continue
    seen.add(id)
    const icon = toIcon(m.to)
    out.push({ ...r, agent_reply: { message_id: id, to_name: toName(m.to), ...(icon ? { to_icon: icon } : {}), sent_at: m.since, ...(m.handed_at ? { handed_at: m.handed_at } : {}) } })
  }
  return out.sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts))
}

/** 人が返答のバブルの下から送った返信（#700）の、画面に出す文の長さ（頭だけ） */
export const FOLLOWUP_SHOWN_CHARS = 40
/** その返信で回ったターンを探すときに、入力の頭を何文字比べるか（record.py は入力を 2000 字で切り、添付のパスは後ろに足される） */
export const FOLLOWUP_MATCH_CHARS = 200

/** 画面に出す頭（1 行目だけ。長ければ切って … を付ける） */
export function followupHead(text: string): string {
  const line = text.trim().split('\n')[0]!.trim()
  const chars = [...line]
  return chars.length > FOLLOWUP_SHOWN_CHARS ? `${chars.slice(0, FOLLOWUP_SHOWN_CHARS).join('')}…` : line
}

/**
 * 人が返答のバブルの下から相手へ送った返信（#700）に、相手が返した行を引く。`sai_send` と違って見出しに id が無いので、
 * **相手のセッションの、送ったあとのターン完了の行のうち、入力の頭が送った文と同じ最初の 1 つ**を当てる
 * （預かりに並んだときは間に別のターンが終わるので、「次のターン完了」では当てない）。
 * - 1 つの行は 1 つの返信にしか当てない（同じ文を 2 回送ったら、古い順に 1 つずつ）
 * - 入力が記録に無いターン（入力の行を書かないエージェント・要約で置き換わった入力）には当たらない。当たらなければ出さないだけ
 * - `rows` は古い順（`deliveryMatcher()` が直前の入力の行を見る）
 *
 * 返すのは `agent_reply` に `followup` の印を付けた行（古い順）と、返信の id → その行の `ts`
 */
export function followupReplyRows(
  followups: readonly { id: string; to: string; text: string; at: string }[],
  rows: readonly FeedRow[],
  toName: (id: string) => string,
  toIcon: (id: string) => string | undefined = () => undefined,
): { rows: FeedRow[]; answered: Map<string, string> } {
  const answered = new Map<string, string>()
  const out: FeedRow[] = []
  if (followups.length === 0) return { rows: out, answered }
  const open = [...followups].sort((a, b) => Date.parse(a.at) - Date.parse(b.at)).map((f) => ({ f, at: Date.parse(f.at), head: f.text.trim().slice(0, FOLLOWUP_MATCH_CHARS) }))
  const matcher = deliveryMatcher()
  for (const r of rows) {
    // 相手に未渡しの返答があると、SAI が本文の頭に返答の塊を足して渡す（#594）。比べるのは人が打った文だけ
    const input = splitHandedReplies(matcher.headOf(r)).text.trim()
    if (!input) continue
    const entity = entityId(r.session ?? '', r.repo ?? '', String(r.ts ?? ''))
    const ts = Date.parse(r.ts)
    const hit = open.find((o) => !answered.has(o.f.id) && o.f.to === entity && o.head !== '' && ts > o.at && input.startsWith(o.head))
    if (!hit) continue
    answered.set(hit.f.id, r.ts)
    const icon = toIcon(hit.f.to)
    out.push({ ...r, agent_reply: { message_id: hit.f.id, to_name: toName(hit.f.to), ...(icon ? { to_icon: icon } : {}), sent_at: hit.f.at, followup: true } })
  }
  return { rows: out, answered }
}

/** 行の入力が、そのメッセージで回ったターンのものか（見出しの id で見る） */
export function isDeliveryOf(userText: string | undefined, messageId: string): boolean {
  const head = (userText ?? '').trimStart().slice(0, 400)
  return head.startsWith(AGENT_HEADER_MARK) && head.includes(`（id: ${messageId}）`)
}

/** 相手の返答になる行（そのメッセージで回った、相手のターン完了の行）。まだ無ければ null。`rows` は古い順 */
export function replyOf(rows: readonly FeedRow[], to: string, messageId: string): FeedRow | null {
  const matcher = deliveryMatcher()
  for (const r of rows) {
    if (entityId(r.session ?? '', r.repo ?? '', String(r.ts ?? '')) !== to) continue
    if (isDeliveryOf(matcher.headOf(r), messageId)) return r
  }
  return null
}

/** 長い返答を切る。切ったらそう書く（送り元の会話を膨らませない。#311） */
export function clipReply(text: string, max: number = AGENT_REPLY_MAX_CHARS): string {
  const t = text.trim()
  return t.length <= max ? t : `${t.slice(0, max)}\n…（あと ${t.length - max} 字を省略。続きは相手のセッションで）`
}

/**
 * 返答を出すときの相手の呼び名（#588）。表示名が無ければ題名に落ちるが、受け取ったセッションの題名は**届けた見出しそのもの**
 * （一番新しい入力が「【SAI】…からのメッセージです」になる）ので、そのときは worktree 名にする
 */
export function replierName(s: Pick<SessionSummary, 'id' | 'title' | 'meta' | 'repo'>): string {
  const label = sessionLabel(s)
  return label.startsWith(AGENT_HEADER_MARK) ? `#${s.repo}` : label
}

/** セッションの呼び名。表示名 → 題名 → ID */
export function sessionLabel(s: Pick<SessionSummary, 'id' | 'title' | 'meta'>): string {
  return s.meta?.name || s.title || s.id
}

/**
 * 送ってよい相手（#310 の最初の PR）。**同じ project の中**と、**人が許した組の先の project**（#747。`across`）・
 * 自分以外・アーカイブ済みでない・返信できる（別のマシン・合成 ID・エージェント不明は `replyBlockedReason()` で落ちる）。
 * 既定（`across` が空）で同じ project に絞るのは、素通し（bypassPermissions）のセッションに外から指示が入る範囲を狭めるため（#253）。
 * またいだ先が素通しでも送れる（#747 で決めた。範囲は人が許した組で縛る）。並びは同じ project が先
 */
export function agentTargets(sessions: readonly SessionSummary[], from: SessionSummary, serverHost: string, across: readonly SendAcrossPair[] = []): SessionSummary[] {
  if (!from.project) return []
  const ok = (s: SessionSummary) => s.id !== from.id && !s.archived && !replyBlockedReason(s, serverHost)
  return [...sessions.filter((s) => s.project === from.project && ok(s)), ...sessions.filter((s) => isAcross(from, s, across) && ok(s))]
}

/** `s` が、`from` から見て**別のリポジトリの、送ってよい組の先**のセッションか（#747） */
export function isAcross(from: Pick<SessionSummary, 'project'>, s: Pick<SessionSummary, 'project'>, across: readonly SendAcrossPair[]): boolean {
  return Boolean(s.project) && s.project !== from.project && mayCross(across, from.project, s.project)
}

/**
 * 別のリポジトリのセッションの呼び名（#747）。**人が付けた表示名だけ**で、無ければ `#<worktree 名>`。
 * `sessionLabel()` は表示名が無いと題名（相手のリポジトリの人の入力の 1 行目）に落ちるので、またいだ相手には使わない
 * （頼んでいない中身が、送り元のエージェントの文脈へ流れる）
 */
export function acrossLabel(s: Pick<SessionSummary, 'id' | 'repo' | 'meta'>): string {
  return s.meta?.name || (s.repo ? `#${s.repo}` : s.id)
}

/**
 * 別のリポジトリのセッションを宛先として書ける名前（#747）: **id と、人が付けた表示名だけ**。worktree 名と題名では当てない
 * （`main` のような worktree 名はどのリポジトリにもあり、送り元の側に同じ名前のセッションが居ないだけで、別のリポジトリへ黙って届く）
 */
export function acrossNames(s: Pick<SessionSummary, 'id' | 'meta'>): string[] {
  return [...new Set([s.id, s.meta?.name ?? ''].map(targetKey).filter(Boolean))]
}

/**
 * sai_sessions が返す、**別のリポジトリのセッション**の 1 件（#747）。出すのは呼び名・エージェント・空いているか、まで
 * （最後の発言・ブランチ・「同じファイル」・PR・読み直す量は載せない。別のリポジトリの記録を、頼んでいないのに送り元の文脈へ流さない）
 */
export function acrossEntry(s: SessionSummary, busy: boolean, free: boolean): AgentSessionEntry {
  return { id: s.id, name: acrossLabel(s), project: s.project, branch: '', agent: s.agent, busy, last_text: '', context_tokens: 0, overlap: [], overlap_more: 0, across: true, ...(free ? { holding: { free: true as const } } : {}) }
}

/** 宛先の名前を比べる形（#625）。前後の空白と大文字小文字だけ無視する（前方一致・あいまいな一致はしない） */
const targetKey = (name: string): string => name.trim().toLowerCase()

/** 宛先として書ける名前（#625）: id・表示名・worktree 名（`repo`）・`sai_sessions` に出る呼び名（`sessionLabel()`） */
export function targetNames(s: Pick<SessionSummary, 'id' | 'title' | 'meta' | 'repo'>): string[] {
  return [...new Set([s.id, s.meta?.name ?? '', s.repo, sessionLabel(s)].map(targetKey).filter(Boolean))]
}

/** 宛先を引いた結果。`target` が無ければ送らない（`candidates` は選び直すための一覧。当たりが複数ならその当たり、無ければ送れる相手の全部） */
export type ResolvedTarget = { target: SessionSummary } | { target: null; ambiguous: boolean; candidates: SessionSummary[]; hidden?: number }

/**
 * `sai_send` の宛先（`to`）を、送ってよい相手（`targets`）の中から引く（#625）。id がそのまま当たればそれ。
 * 当たらなければ名前（`targetNames()`）の**完全一致**で探し、**ちょうど 1 つに決まったときだけ**返す。
 * 同じ名前が 2 つ以上（#572）・1 つも無いときは当てない（「セッション B」と「セッション B - 別件」のような取り違えを避ける）。
 *
 * `blocked` は、送れないが居るセッション（素通し・別のマシンなど。アーカイブ済みは渡さない）。**同じ名前がそこにも居れば当てない**:
 * 送れる相手だけで数えると、人が指していた方が送れないセッションのとき、同じ名前の別のセッションに黙って届く（#662 のレビュー）
 */
export function resolveTarget(
  targets: readonly SessionSummary[],
  to: string,
  blocked: readonly SessionSummary[] = [],
  /** そのセッションを指せる名前。既定は `targetNames()`。別のリポジトリの相手には `acrossNames()` を返させる（#747） */
  namesOf: (s: SessionSummary) => string[] = targetNames,
): ResolvedTarget {
  const byId = targets.find((s) => s.id === to)
  if (byId) return { target: byId }
  const key = targetKey(to)
  const hits = key ? targets.filter((s) => namesOf(s).includes(key)) : []
  // 送れないが居るセッションは、いつもの名前（表示名・worktree 名・題名）で数える（どの名前で人が指していたか分からないので広く取る）
  const hidden = hits.length > 0 ? blocked.filter((s) => targetNames(s).includes(key)).length : 0
  if (hits.length === 1 && hidden === 0) return { target: hits[0]! }
  if (hits.length > 0) return { target: null, ambiguous: true, candidates: hits, ...(hidden ? { hidden } : {}) }
  return { target: null, ambiguous: false, candidates: [...targets] }
}

/** 宛先が決まらなかったときに返す文（#625）。候補を id と呼び名で並べ、選び直させる */
export function targetRefusal(to: string, resolved: Extract<ResolvedTarget, { target: null }>, none: string, home = ''): string {
  // 送り元と違うリポジトリの候補には `<リポジトリ>` を添える（#747。同じ呼び名・同じ worktree 名がリポジトリをまたいで重なる）
  // 別のリポジトリの候補は、題名に落ちない呼び名で出す（`acrossLabel()`）
  const far = (s: SessionSummary) => Boolean(home && s.project && s.project !== home)
  const list = resolved.candidates.map((s) => `- ${s.id}「${far(s) ? acrossLabel(s) : sessionLabel(s)}」${far(s) ? `（${s.project}）` : ''}`).join('\n')
  if (resolved.ambiguous) {
    const total = resolved.candidates.length + (resolved.hidden ?? 0)
    const hidden = resolved.hidden ? `（うち ${resolved.hidden} つは送れないセッション。下には送れる方だけ）` : ''
    return `「${to.trim()}」に当たる相手が ${total} つあります${hidden}。送っていません。id で選び直してください:\n${list}`
  }
  return list ? `${none}\n送れる相手:\n${list}` : none
}

/** `overlap` に並べる数（多ければ残りは数だけ） */
export const AGENT_OVERLAP_SHOW = 5

/**
 * 重なりに数えないファイル（#564）。ほぼ全部の PR が触るので、数えると「全員と重なっている」になって役に立たない
 */
export function overlapIgnored(path: string): boolean {
  const name = path.split('/').pop() ?? path
  return name === 'CLAUDE.md' || name === 'README.md' || path.startsWith('docs/')
}

/**
 * 呼んだセッションと相手の worktree の重なり（#564）。**同じ worktree（トップが同じ）なら空**（差分が同じなので、重なりではない。
 * cwd で比べるとサブディレクトリで開いたセッションを別の worktree と取り違える）。パスの順に並べ、先頭 `AGENT_OVERLAP_SHOW` 件と残りの数
 */
export function agentOverlap(
  mine: { root: string; paths: readonly string[] },
  theirs: { root: string; paths: readonly string[] },
): { overlap: string[]; overlap_more: number } {
  if (!mine.root || !theirs.root || mine.root === theirs.root) return { overlap: [], overlap_more: 0 }
  const own = new Set(mine.paths.filter((p) => !overlapIgnored(p)))
  const both = [...new Set(theirs.paths)].filter((p) => own.has(p)).sort()
  return { overlap: both.slice(0, AGENT_OVERLAP_SHOW), overlap_more: Math.max(0, both.length - AGENT_OVERLAP_SHOW) }
}

/**
 * sai_sessions が返す 1 件。本文は載せず、最後の発言の 1 行目だけ。
 * `contextTokens` は相手が読み直す量（直近の呼び出しの入力。分からなければ 0）、`overlap` は同じファイルを触っているか（#564）
 */
export function agentEntry(
  s: SessionSummary,
  busy: boolean,
  contextTokens = 0,
  overlap: { overlap: string[]; overlap_more: number } = { overlap: [], overlap_more: 0 },
): AgentSessionEntry {
  const last = (s.last_text ?? '').split('\n')[0] ?? ''
  return {
    id: s.id,
    name: sessionLabel(s),
    project: s.project,
    branch: s.branch,
    agent: s.agent,
    busy,
    last_text: last.length > LAST_TEXT_CHARS ? `${last.slice(0, LAST_TEXT_CHARS)}…` : last,
    context_tokens: contextTokens,
    overlap: overlap.overlap,
    overlap_more: overlap.overlap_more,
  }
}

/** トークン数を「約 12 万トークン」の形に。0（分からない）は空 */
export function tokensLabel(tokens: number): string {
  if (!(tokens > 0)) return ''
  if (tokens < 10_000) return `約 ${Math.max(1, Math.round(tokens / 1000))} 千トークン`
  return `約 ${Math.round(tokens / 10_000)} 万トークン`
}

/** 枠が戻っていれば（`resets_at` を過ぎた）その値は古いので見ない */
const currentWindow = (w: UsageWindow | undefined, nowSec: number): UsageWindow | undefined =>
  w && (w.resets_at === undefined || w.resets_at > nowSec) ? w : undefined

/**
 * 使用量を見て、送らないなら理由（#311）。見るのは**相手のエージェント**の枠（受け取って読み直すのは相手なので）。
 * 取れなければ止めない（Claude の割合はステータスラインを配線していないと無い。材料が無いのに送れなくしない）
 */
export function usageRefusal(usage: UsageResponse, agent: Agent, now: number = Date.now()): string {
  const nowSec = now / 1000
  const windows = agent === 'claude' ? usage.claude : agent === 'codex' ? usage.codex : undefined
  if (!windows) return ''
  const name = agent === 'claude' ? 'Claude' : 'Codex'
  const limited = usage.claude?.limited
  if (agent === 'claude' && limited && limited.resets_at > nowSec) return `${name} が使用量の上限に当たっているので送りません`
  const five = currentWindow(windows.primary, nowSec)
  if (five && five.used_percent >= AGENT_USAGE_STOP_PERCENT) {
    return `${name} の 5 時間の枠が ${Math.round(five.used_percent)}% 使われているので送りません（${AGENT_USAGE_STOP_PERCENT}% から止める）`
  }
  const week = currentWindow(windows.secondary, nowSec)
  if (week && week.used_percent >= AGENT_WEEKLY_STOP_PERCENT) {
    return `${name} の週の枠が ${Math.round(week.used_percent)}% 使われているので送りません（${AGENT_WEEKLY_STOP_PERCENT}% から止める）`
  }
  return ''
}

/**
 * このターンでもう相手に読み直させた量（`spent`）に、この相手のぶん（`next`）を足すと予算を超えるなら理由（#311）。
 * 相手の大きさが分からなければ止めない
 */
export function budgetRefusal(spent: number, next: number, budget: number = AGENT_TURN_READ_BUDGET): string {
  if (!(next > 0) || spent + next <= budget) return ''
  return `このターンで相手に読み直させる量が予算を超えます（これまで ${spent > 0 ? tokensLabel(spent) : '0'}、この相手は${tokensLabel(next)}、予算は${tokensLabel(budget)}）。小さい相手を選ぶか、人に確かめてください`
}

/**
 * 依頼 1 つの上限（#727）に収まるか。収まれば空、収まらなければ理由。**預かる前に、依頼の全部について**呼ぶ
 * （`sizes` はこれから足す宛先ごとの読み直す量、`count` / `read` はその依頼でもう送った分と預かっている分）
 */
export function requestRefusal(count: number, read: number, sizes: readonly { name: string; tokens: number; hidden?: boolean }[], hideRead = false): string {
  const total = count + sizes.length
  if (total > AGENT_REQUEST_MAX) {
    return `1 つの依頼で送れるのは ${AGENT_REQUEST_MAX} 件までです（もう ${count} 件、今回 ${sizes.length} 件）。1 件も預かっていません。宛先を減らすか、人に確かめてください`
  }
  const adding = sizes.reduce((sum, s) => sum + (s.tokens > 0 ? s.tokens : 0), 0)
  if (adding > 0 && read + adding > AGENT_REQUEST_READ_BUDGET) {
    // 別のリポジトリの相手（`hidden`。#747）が混ざる依頼では、相手ごとの量も合計も出さない（一覧で伏せた量を、断りの文から出さない）
    // これまでの合計に伏せた分が入っているとき（`hideRead`）も同じ（引き算で分かる）
    if (hideRead || sizes.some((s) => s.hidden)) return `この依頼で相手に読み直させる量の合計が予算を超えます（予算は${tokensLabel(AGENT_REQUEST_READ_BUDGET)}。別のリポジトリの相手の量は出しません）。1 件も預かっていません。相手を減らすか、人に確かめてください`
    const each = sizes.filter((s) => s.tokens > 0).map((s) => `${s.name} ${tokensLabel(s.tokens).trim()}`).join('、')
    return `この依頼で相手に読み直させる量の合計が予算を超えます（これまで ${read > 0 ? tokensLabel(read).trim() : '0'}、今回 ${tokensLabel(adding).trim()}＝${each}。予算は${tokensLabel(AGENT_REQUEST_READ_BUDGET)}）。1 件も預かっていません。小さい相手に絞るか、人に確かめてください`
  }
  return ''
}

// ---- 返答を送り元の会話に戻す（#594）

/** 送り元の次のターンの頭に足す返答の塊の始まり。`【SAI】` で始めない（`deliveredId()` が届けた見出しと取り違えないように） */
export const HANDED_MARK = '【SAI 返答】'
/** 塊の終わり。ここから後ろが人（か預かり）の本文 */
export const HANDED_END = '【SAI 返答ここまで。以下が今回の指示です】'
/** 1 回に足す返答の数の上限。超えた分は 1 行で名前だけ知らせる（渡した扱いにする） */
export const HANDED_MAX_ITEMS = 8
/** 1 回に足す返答の本文の合計の上限（字）。1 件は `clipReply()` の長さのまま。実データの返答は 1 件 539〜2,060 字 */
export const HANDED_MAX_CHARS = 12_000
/** 送ってからこれより古い返答は足さない（何日も前の依頼の返答を、関係の無い次のターンに混ぜない） */
export const HANDED_KEEP_DAYS = 7

/** 走っているターンの途中に返答だけを足すとき（#594 の 2）の、塊のあとに置く本文 */
export const STEERED_NOTE = '（走っているターンの途中で届いた返答です。いまの作業の続きに使ってください）'
/** 返答がそろって送り元を起こすとき（#594 の 3。`sai_send` の `wake`）の、塊のあとに置く本文 */
export const WAKE_NOTE = '（「返答が来たら起こす」で送ったメッセージの返答がそろいました。続きを進めてください。このターンから別のセッションへは送れません）'

/** 人が打った文ではなく、SAI が置いた本文か（返答を渡すためだけの文・ループの周の文。題名にしない） */
export function isHandedOnly(text: string): boolean {
  const t = text.trim()
  // ループの周として SAI が送った本文（#634）も、人が打った文ではない
  // 待ちが終わって SAI が起こしたターンの本文（#732）も同じ
  return t === STEERED_NOTE || t === WAKE_NOTE || isLoopPrompt(t) || isWaitPrompt(t)
}

/** 送り元にまだ渡していない返答 1 件 */
export interface PendingReply {
  message_id: string
  /** 相手の呼び名 */
  to_name: string
  status: 'done' | 'failed'
  /** done のときの返答（`clipReply()` 済み） */
  text?: string
  /** failed のときの理由 */
  error?: string
}

/**
 * 送り元の次のターンの本文の頭に、まだ渡していない返答を足す（#594）。返答が無ければ本文をそのまま返す。
 * 古い順に `HANDED_MAX_ITEMS` 件・合計 `HANDED_MAX_CHARS` 字まで本文を載せ、入りきらない分は名前と id だけの 1 行にする。
 * 足したものは全部「渡した」にする（名前だけの分も、あることは伝わっているので 2 回は足さない）
 */
export function withHandedReplies(text: string, replies: readonly PendingReply[]): string {
  if (replies.length === 0) return text
  const blocks: string[] = []
  const rest: PendingReply[] = []
  let used = 0
  for (const r of replies) {
    const body = r.status === 'failed' ? `--- 「${r.to_name}」（message_id: ${r.message_id}）への依頼は失敗しました: ${r.error ?? ''}` : `--- 「${r.to_name}」（message_id: ${r.message_id}）からの返答:\n${r.text ?? ''}`
    if (blocks.length >= HANDED_MAX_ITEMS || (blocks.length > 0 && used + body.length > HANDED_MAX_CHARS)) {
      rest.push(r)
      continue
    }
    blocks.push(body)
    used += body.length
  }
  if (rest.length > 0) blocks.push(`--- ほか ${rest.length} 件（本文は相手のセッションで読めます）: ${rest.map((r) => `「${r.to_name}」（message_id: ${r.message_id}）`).join('、')}`)
  const head = `${HANDED_MARK}あなたが別のセッションに送ったメッセージへの返答が ${replies.length} 件届いています（待たずにターンを終えたので、ここで渡します）。`
  return `${head}\n\n${blocks.join('\n\n')}\n\n${HANDED_END}\n\n${text}`
}

/**
 * 本文の頭に足した返答の塊を外す（#594）。画面の自分のバブル・題名・↑ の履歴は人が打った文だけを見せる。
 * 記録の `user_text` には塊ごと残る（SAI は行を書き換えない）。塊が無ければ `handed: 0` でそのまま
 */
export function splitHandedReplies(userText: string): { text: string; handed: number } {
  if (!userText.startsWith(HANDED_MARK)) return { text: userText, handed: 0 }
  const end = userText.indexOf(HANDED_END)
  if (end < 0) return { text: userText, handed: 0 }
  const handed = Number(/返答が (\d+) 件届いています/.exec(userText.slice(0, 200))?.[1] ?? 0)
  return { text: userText.slice(end + HANDED_END.length).replace(/^\s+/, ''), handed }
}


/** sai_sessions の一覧で、別のリポジトリのセッション（#747）の前に置く見出し */
export const ACROSS_HEADING = '別のリポジトリ（送れる。相手からは、あなたのリポジトリのファイルは読めません）:'

/** `sai_send` の説明に足す、別のリポジトリへ送るときの書き方（#747） */
export const ACROSS_NOTE = '**別のリポジトリのセッションに送るとき**（sai_sessions の「別のリポジトリ（送れる）」に並ぶ相手。人が許した組だけ）は、**宛先からは送り元のリポジトリのファイルが読めない前提で、本文だけで動けるように書く**（ファイルのパスではなく、要る中身・形・前提を本文に写す）。呼び名がリポジトリをまたいで重なるときは送られないので、id で選び直す。'

/** 預かったことをエージェントに伝える文（#727）。**送り直させない**のが目的 */
export const HELD_NOTE = `預かった分は、このターンが終わったあと SAI が順に送ります（1 巡 ${AGENT_SEND_MAX} 件まで、巡の間は約 ${Math.round(AGENT_BACKLOG_ROUND_MS / 1000)} 秒）。**同じものを送り直さないでください**。人が画面の「送信を止める」を押すと、残りは送られません。送る直前に相手が送れなくなっていた分は送らず、画面に理由を出します。預かった分は sai_wait では待てません（返答は画面と次のターンの頭に届きます）。`

/** `sai_send` の `items` の説明（#727） */
export const SEND_ITEMS_ARG = `複数の相手に 1 つの依頼としてまとめて送るときに使う（{ to, text } の配列。最大 ${AGENT_REQUEST_MAX} 件。あれば to / text は見ない）。**割り振りのように 4 人以上へ頼むときはこれを使う**: 先に全部の相手の読み直す量を数え、合計が依頼の予算を超えるなら 1 件も送らずに断る。収まれば上から順に、このターンで送れる回数まではその場で送り、残りは預かってターンが終わってから順に送る`

/** `sai_send` の説明に足す、着手の頼み方（#624）。セッション同士の口（`approve-mcp.ts`）と tailnet の `/mcp` が同じ文を出す */
export const SEND_COMPACT_NOTE =
  '**着手を頼むときは、1 行目を「#N に着手してください。」だけにして、説明は 2 行目から書く**（1 行目がその形なら、相手は要約（/compact）してから始めるので読み直す量が減る。1 行目に続きを書くと要約されない）'

/** `sai_send` の `compact` の説明（#624） */
export const SEND_COMPACT_ARG =
  '相手に要約（/compact）してから始めさせるか。省略すれば 1 行目が着手の形のときだけ要約する。調査のような着手の形でない依頼でも要約させたいときは true、着手の形でも要約させたくないときは false。要約できない相手（端末で開いている・Claude でない・文脈が小さい）はそのまま始める'

/** 宛先（`to`）の説明（#625）。セッション同士の口と tailnet の `/mcp` で同じ文 */
export const SEND_TO_ARG =
  '送り先。セッションの id か、呼び名（表示名・worktree 名・sai_sessions に出る呼び名。完全一致で、大文字小文字と前後の空白は無視）。呼び名がちょうど 1 つに決まったときだけ送り、決まらなければ送らずに候補を返す'

/** `sai_send` の返事の、相手のターンをどう回したか（#624。`via` は `ReplyResponse` のもの） */
export function sendHow(via: string): string {
  if (via === 'queued') return '相手は処理中なので、終わってから回ります（要約は挟みません）'
  if (via === 'compact') return '相手は要約（/compact）してから始めます'
  return '相手のターンを始めました'
}
