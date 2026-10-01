// セッション同士のメッセージ（#310 / #311）。SAI の MCP サーバのツール（sai_sessions / sai_send / sai_wait）と
// SAI サーバが同じ規則を見る。DOM にもファイルにも触らないので shared/agentMessages.test.ts で回す
import { entityId } from './entity.ts'
import { eventKind } from './events.ts'
import { replyBlockedReason } from './reply.ts'
import type { Agent, AgentSessionEntry, FeedRow, SessionSummary, UsageResponse, UsageWindow } from './types.ts'

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
 * 送ったメッセージへの返答の行（#588）。送り元が `sai_wait` せずにターンを終えると、返答は相手のセッションにしか無く、
 * 送り元の会話は「頼みました」で止まって見える。そこで**送り元の画面に並べる**ために、相手のターン完了の行に印を付けて返す。
 * 行は 1 回だけ舐める（メッセージごとに `replyOf()` を呼ぶと、3 秒のポーリングのたびに 送った数 × 行 になる）。
 * 相手が違う行（見出しを写しただけの行）は数えない。古い順
 */
export function agentReplyRows(
  sent: readonly { message_id: string; to: string; since: string; handed_at?: string }[],
  rows: readonly FeedRow[],
  toName: (id: string) => string,
): FeedRow[] {
  const want = new Map(sent.map((m) => [m.message_id, m]))
  if (want.size === 0) return []
  const out: FeedRow[] = []
  const seen = new Set<string>()
  for (const r of rows) {
    if (eventKind(r.event, r.text) !== 'turn') continue
    const id = deliveredId(r.user_text)
    const m = id ? want.get(id) : undefined
    if (!m || seen.has(id)) continue
    if (entityId(r.session ?? '', r.repo ?? '', String(r.ts ?? '')) !== m.to) continue
    seen.add(id)
    out.push({ ...r, agent_reply: { message_id: id, to_name: toName(m.to), sent_at: m.since, ...(m.handed_at ? { handed_at: m.handed_at } : {}) } })
  }
  return out.sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts))
}

/** 行の入力が、そのメッセージで回ったターンのものか（見出しの id で見る） */
export function isDeliveryOf(userText: string | undefined, messageId: string): boolean {
  const head = (userText ?? '').trimStart().slice(0, 400)
  return head.startsWith(AGENT_HEADER_MARK) && head.includes(`（id: ${messageId}）`)
}

/** 相手の返答になる行（そのメッセージで回った、相手のターン完了の行）。まだ無ければ null */
export function replyOf(rows: readonly FeedRow[], to: string, messageId: string): FeedRow | null {
  for (const r of rows) {
    if (eventKind(r.event, r.text) !== 'turn') continue
    if (entityId(r.session ?? '', r.repo ?? '', String(r.ts ?? '')) !== to) continue
    if (isDeliveryOf(r.user_text, messageId)) return r
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
 * 送ってよい相手（#310 の最初の PR）。**同じ project の中だけ**・自分以外・アーカイブ済みでない・返信できる
 * （別のマシン・合成 ID・エージェント不明は `replyBlockedReason()` で落ちる）。
 * 同じ project に絞るのは、素通し（bypassPermissions）のセッションに外から指示が入る範囲を狭めるため（#253）
 */
export function agentTargets(sessions: readonly SessionSummary[], from: SessionSummary, serverHost: string): SessionSummary[] {
  if (!from.project) return []
  return sessions.filter((s) => s.id !== from.id && s.project === from.project && !s.archived && !replyBlockedReason(s, serverHost))
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

/** 人が打った文ではなく、SAI が返答を渡すためだけに置いた本文か（題名にしない） */
export function isHandedOnly(text: string): boolean {
  const t = text.trim()
  return t === STEERED_NOTE || t === WAKE_NOTE
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

