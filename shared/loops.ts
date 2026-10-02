// セッションに組むループ（#634）の決まりごと。サーバ（組む・起こす・止める）と画面（文言）と MCP のツールの説明が同じものを使う。
//
// 3 つを組にしてある: **目的と終わりの条件は人**が決め、**次にいつ起きるか・終わったかはエージェント**が周の終わりに言い
// （`sai_loop_next`）、**上限と止めることは SAI** が持つ（エージェントからは動かせない）。ここは DOM にも fs にも依らない純粋関数だけ
import { TIME_ZONE } from './entity.ts'
import type { Loop, LoopRequest, LoopStatus } from './types.ts'

/** SAI がループの周として送った本文の頭。画面はこれで見分けて、長い本文の代わりに「ループ N 周目」と出す */
export const LOOP_MARK = '【SAI ループ】'

/** 周の数の上限（既定と、組むときに選べる最大） */
export const LOOP_DEFAULT_ROUNDS = 10
export const LOOP_MAX_ROUNDS = 50
/** 組んでから止めるまでの時間（既定と最大） */
export const LOOP_DEFAULT_HOURS = 2
export const LOOP_MAX_HOURS = 24
/** 起こす間隔（秒）。エージェントが言った値もこの範囲に丸める */
export const LOOP_MIN_INTERVAL_S = 60
export const LOOP_MAX_INTERVAL_S = 3600
export const LOOP_DEFAULT_INTERVAL_S = 600
/** 申し送りが前の周と同じまま、これだけ続いたら止める（進んでいない） */
export const LOOP_STALL_ROUNDS = 3
/** 目的・終わりの条件・申し送りの長さの上限（字） */
export const LOOP_TEXT_MAX = 2000
export const LOOP_NOTE_MAX = 2000

/** エージェントに見せるツールの名前（`server/approvals/approve-mcp.ts`） */
export const LOOP_TOOL = 'sai_loop_next'

/** 回っているか止まっているだけ（まだ続きがある）か。終わったループは組み直せる */
export function loopLive(status: LoopStatus): boolean {
  return status === 'running' || status === 'paused'
}

/** 間隔を下限と上限に丸める。数でなければ既定の間隔 */
export function clampInterval(seconds: unknown, fallback: number = LOOP_DEFAULT_INTERVAL_S): number {
  const n = typeof seconds === 'number' && Number.isFinite(seconds) ? seconds : fallback
  return Math.min(LOOP_MAX_INTERVAL_S, Math.max(LOOP_MIN_INTERVAL_S, Math.round(n)))
}

const intIn = (v: unknown, fallback: number, min: number, max: number): number | null => {
  if (v === undefined || v === null) return fallback
  if (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > max) return null
  return v
}

/**
 * 組むときの検査。**目的・終わりの条件・上限は空では組めない**（上限は省略すると既定値が入るので、上限なしにはならない）。
 * 数字が範囲の外なら丸めずに断る（人が打った値を黙って変えない）
 */
export function loopFromRequest(body: unknown, now: number): { loop: Loop } | { error: string } {
  const b = (body && typeof body === 'object' ? body : {}) as Partial<LoopRequest>
  const goal = typeof b.goal === 'string' ? b.goal.trim() : ''
  const until = typeof b.until === 'string' ? b.until.trim() : ''
  if (!goal) return { error: '目的（goal）が要ります' }
  if (!until) return { error: '終わりの条件（until）が要ります' }
  if (goal.length > LOOP_TEXT_MAX || until.length > LOOP_TEXT_MAX) return { error: `目的と終わりの条件はそれぞれ ${LOOP_TEXT_MAX} 字までです` }
  const rounds = intIn(b.max_rounds, LOOP_DEFAULT_ROUNDS, 1, LOOP_MAX_ROUNDS)
  if (rounds === null || !Number.isInteger(rounds)) return { error: `周の上限（max_rounds）は 1〜${LOOP_MAX_ROUNDS} の整数です` }
  const hours = intIn(b.hours, LOOP_DEFAULT_HOURS, 0.1, LOOP_MAX_HOURS)
  if (hours === null) return { error: `時間の上限（hours）は 0.1〜${LOOP_MAX_HOURS} です` }
  const interval = intIn(b.interval_s, LOOP_DEFAULT_INTERVAL_S, LOOP_MIN_INTERVAL_S, LOOP_MAX_INTERVAL_S)
  if (interval === null) return { error: `既定の間隔（interval_s）は ${LOOP_MIN_INTERVAL_S}〜${LOOP_MAX_INTERVAL_S} 秒です` }
  const at = new Date(now).toISOString()
  return {
    loop: { goal, until, max_rounds: rounds, deadline: new Date(now + hours * 3_600_000).toISOString(), interval_s: Math.round(interval), status: 'running', round: 0, next_at: at, since: at },
  }
}

/** `12:30`（日付の切り方と同じ `Asia/Tokyo`）。日付が今日でなければ `10/3 12:30` */
export function loopClock(iso: string, now: number): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const time = d.toLocaleTimeString('ja-JP', { timeZone: TIME_ZONE, hour: '2-digit', minute: '2-digit', hour12: false })
  const day = (x: Date) => x.toLocaleDateString('ja-JP', { timeZone: TIME_ZONE, month: 'numeric', day: 'numeric' })
  return day(d) === day(new Date(now)) ? time : `${day(d)} ${time}`
}

const minutes = (seconds: number): string => (seconds % 60 === 0 ? `${seconds / 60} 分` : `${seconds} 秒`)

/**
 * 周の頭に送る文。SAI が組む（エージェントの会話が要約されても、目的・条件・申し送りは毎周ここで渡し直す）。
 * `loop.round` はこれから送る周の番号（1 から）
 */
export function loopPrompt(loop: Pick<Loop, 'goal' | 'until' | 'max_rounds' | 'deadline' | 'interval_s' | 'round' | 'note'>, now: number): string {
  const last = loop.round >= loop.max_rounds
  return [
    `${LOOP_MARK}${loop.round} 周目 / 上限 ${loop.max_rounds} 周（${loopClock(loop.deadline, now)} まで）`,
    '',
    `目的: ${loop.goal}`,
    `終わりの条件: ${loop.until}`,
    `前の周の申し送り: ${loop.note?.trim() || '（まだありません）'}`,
    '',
    'この周でやること: 目的に向けて進め、終わりの条件を満たしたかを確かめてください。',
    `周の最後に、必ず ${LOOP_TOOL} を 1 回呼んでからターンを終えてください:`,
    `- まだ続きがある: action "continue"。seconds に次に起きるまでの秒（${LOOP_MIN_INTERVAL_S}〜${LOOP_MAX_INTERVAL_S} に丸められます。待つものが無ければ短く、CI などを待つなら終わりそうな頃に）、note に次の周への申し送り（この周でやったこと・次に見ること）`,
    '- 終わりの条件を満たした: action "done"。note に根拠（確かめた結果）',
    '- 進められない・人の判断が要る: action "give_up"。note に理由',
    last ? 'これが上限の最後の周です。このあとは起こされません。' : `呼ばずに終えると ${minutes(loop.interval_s)}後にもう一度起こされます。`,
    '上限と目的は変えられません。人が決めることを勝手に進めないでください。',
  ].join('\n')
}

/** SAI がループの周として送った本文か */
export function isLoopPrompt(text: string): boolean {
  return text.trimStart().startsWith(LOOP_MARK)
}

/** 画面に出す短い形（`ループ 3 周目`）。ループの本文でなければそのまま返す */
export function loopPromptLabel(text: string): string {
  if (!isLoopPrompt(text)) return text
  const n = /^(\d+) 周目/.exec(text.trimStart().slice(LOOP_MARK.length))?.[1]
  return n ? `ループ ${n} 周目` : 'ループの周'
}

/** エージェントが周の終わりに言ったこと（`continue` のとき） */
export interface LoopSaid {
  /** 丸めたあとの秒 */
  seconds: number
  note: string
}

/** サーバが持つ形。画面に出す `Loop` に、周のターンと数えているものを足したもの */
export interface LoopState extends Loop {
  /** 回っている周のターン（`Replying.since`。起動している最中は `pending`）。無ければ周の合間 */
  turn?: string
  /** この周でエージェントが言ったこと。言っていなければ無い */
  said?: LoopSaid
  /** 申し送りが前の周と同じだった周の数 */
  stalled?: number
  /** 起こすときに使う、このサーバ自身の宛先（許可・質問を画面で答える MCP の宛先。`selfUrl()`） */
  url?: string
}

/** 終わりにする・止める。次の時刻と周のターンは消す */
export function loopHalt(loop: LoopState, status: Exclude<LoopStatus, 'running'>, reason: string): LoopState {
  const { next_at: _next, turn: _turn, said: _said, ...rest } = loop
  // 一時停止は、回っている周のターンを覚えたままにする（再開したあと、その周の終わりから続ける）
  return { ...rest, status, reason, ...(status === 'paused' && loop.turn ? { turn: loop.turn } : {}), ...(status === 'paused' && loop.said ? { said: loop.said } : {}) }
}

/**
 * 周のターンが（失敗せずに）終わったあとの状態。エージェントが言った秒（言わなければ既定の間隔）で次の時刻を決める。
 * 止めるのは 2 つ: 上限の周を回り切った・**申し送りが前の周と同じまま `LOOP_STALL_ROUNDS` 周続いた**（進んでいない）。
 * ツールを呼ばなかった周は「同じ」に数えない（一定の間隔で同じ文を送る見回りは、上限までそのまま回る）
 */
export function loopAfterRound(loop: LoopState, now: number): LoopState {
  const { turn: _turn, said, ...rest } = loop
  const same = said !== undefined && said.note.trim() === (loop.note ?? '').trim() && loop.round > 1
  const stalled = said === undefined ? (loop.stalled ?? 0) : same ? (loop.stalled ?? 0) + 1 : 0
  const next: LoopState = { ...rest, stalled, ...(said ? { note: said.note } : {}) }
  if (loop.status !== 'running') return next
  if (stalled >= LOOP_STALL_ROUNDS - 1) return loopHalt(next, 'stopped', `申し送りが ${LOOP_STALL_ROUNDS} 周続けて同じでした（進んでいないので止めました）`)
  if (loop.round >= loop.max_rounds) return loopHalt(next, 'stopped', `上限の ${loop.max_rounds} 周を回りました`)
  return { ...next, next_at: new Date(now + (said?.seconds ?? loop.interval_s) * 1000).toISOString() }
}

/** 画面に出す形（周のターン・数えているもの・宛先は落とす） */
export function loopView(loop: LoopState): Loop {
  const { turn, said: _said, stalled: _stalled, url: _url, ...rest } = loop
  return { ...rest, ...(turn ? { turning: true as const } : {}) }
}

const STATUS_LABEL: Record<LoopStatus, string> = { running: 'ループ中', paused: 'ループ一時停止', done: 'ループ完了', gave_up: 'ループ中断（エージェントが諦めた）', stopped: 'ループ停止' }

/** `ループ中: 3 周目 / 上限 10・次は 12:30`。画面の 1 行 */
export function loopStatusLine(loop: Loop, now: number): string {
  const parts = [`${loop.round} 周目 / 上限 ${loop.max_rounds}`]
  if (loop.status === 'running') parts.push(loop.turning ? 'いま回っています' : loop.next_at ? `次は ${loopClock(loop.next_at, now)}` : '次を待っています')
  if (loopLive(loop.status)) parts.push(`${loopClock(loop.deadline, now)} まで`)
  return `${STATUS_LABEL[loop.status]}: ${parts.join('・')}`
}
