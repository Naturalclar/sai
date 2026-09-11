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
 * 相手に届ける文。見出しの 1 行で「人ではなく別のセッションから」「返答はこのターンの最後の発言」を伝える。
 * 画面では受け取った側の自分バブルにそのまま出るので、誰から来たかも見える。
 * **見出しに message_id を入れる**: record.py は `user_text` を 2000 字で切るので、本文の一致ではどのターンか決められない
 */
export function deliveredText(from: { label: string; project: string }, messageId: string, text: string): string {
  return `${AGENT_HEADER_MARK}#${from.project} の「${from.label}」からのメッセージです（id: ${messageId}）。このターンの最後の発言が送り元に返ります。\n\n${text.trim()}`
}

/**
 * tailnet の MCP（`/mcp`。#312）から送るときの見出し。送り元はセッションではなく、呼んだ人（ログイン名）かタグ付きの端末。
 * 印と id の形は `deliveredText()` と同じにして、`isDeliveryOf()` / `replyOf()` がそのまま返答を探せるようにする
 */
export function deliveredFromTailnet(caller: string, messageId: string, text: string): string {
  return `${AGENT_HEADER_MARK}tailnet の「${caller}」からのメッセージです（id: ${messageId}）。このターンの最後の発言が送り元に返ります。\n\n${text.trim()}`
}

/** 行の入力が、そのメッセージで回ったターンのものか（見出しの id で見る） */
export function isDeliveryOf(userText: string | undefined, messageId: string): boolean {
  const head = (userText ?? '').trimStart().slice(0, 400)
  return head.startsWith(AGENT_HEADER_MARK) && head.includes(`（id: ${messageId}）`)
}

/** 相手の返答になる行（そのメッセージで回った、相手のターン完了の行）。まだ無ければ null */
export function replyOf(rows: readonly FeedRow[], to: string, messageId: string): FeedRow | null {
  for (const r of rows) {
    if (eventKind(r.event) !== 'turn') continue
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

/**
 * sai_sessions が返す 1 件。本文は載せず、最後の発言の 1 行目だけ。
 * `contextTokens` は相手が読み直す量（直近の呼び出しの入力。分からなければ 0）
 */
export function agentEntry(s: SessionSummary, busy: boolean, contextTokens = 0): AgentSessionEntry {
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
