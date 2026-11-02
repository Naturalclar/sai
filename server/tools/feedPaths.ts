// ペインの中のターンと届け方を週ごとに数える（#845。#843 の段階 3 の線を数字で見る）。`pnpm feed paths` の読み方。
// **読むだけ**で、出すのは数だけ（本文・パス・リポジトリの名前は返さない）。数える関数は純粋関数で、読むのは 2 つ:
//   ターン完了     記録の行（`pane` があればペインの中）
//   届け方         `reply.log` の `--- <時刻> <エンティティ> <文>` の行（`ReplyResponse.via` はどこにも残らない）
//   ダイアログ     同じく `reply.log`（`approvals.jsonl` には今回だけの答えが残らない）
import { createReadStream } from 'node:fs'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { localDate } from '../../shared/entity.ts'
import type { FeedRow } from '../../shared/types.ts'
import { TERMINAL_DIALOG_LOG, TERMINAL_TYPED_LOG } from '../reply/terminal.ts'
import { dateRange, datesBetween, inRange, isTurn } from './feedRead.ts'
import type { DateRange } from './feedRead.ts'

export const REPLY_LOG_FILE = 'reply.log'
/** 範囲を指定しないときに出す週の数（今週を含む） */
export const PATHS_WEEKS = 4

export type Delivery = 'terminal' | 'dialog' | 'process' | 'app_server' | 'queue' | 'parked'

export interface DeliveryEntry {
  ts: string
  delivery: Delivery
}

const LOG_HEAD = /^--- (\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z) \S+ (.*)$/

/** 書く側の文の頭。`server/app.ts` の文を変えたらここも直す（`feedPaths.test.ts` が突き合わせる） */
/**
 * 預かった行。同じ頭の「待つ」「預かりを止めた」は取り直しが重なるので数えない。
 * 預かりに先客がいた 2 通目以降は別の文の行になるので入らず、**この列は下限の目安**
 */
export const PARKED_LOG = /^メッセージを端末に打ち込めない（.*ので、別プロセスを起こさずに預かった（/
export const DELIVERY_LOG_HEADS: readonly (readonly [string, Delivery])[] = [
  ['開いている Codex へ queue ', 'queue'],
  ['Codex app-server で再開', 'app_server'],
  ['opencode serve へ送る', 'app_server'],
  ['Codex の新しいセッション', 'app_server'],
  ['Codex のセッションを分岐', 'app_server'],
  ['OpenCode の新しいセッション', 'app_server'],
  ['OpenCode のセッションを分岐', 'app_server'],
]

/**
 * `reply.log` の 1 行を届け方に読む。届け方の行でなければ null。子の出力も同じファイルに混ざるので、
 * 時刻とエンティティまで揃った行の、決まった文だけを数える（「端末に打ち込んだ返信の…」のような別の文を数えない）
 */
export function deliveryOfLogLine(line: string): DeliveryEntry | null {
  const m = LOG_HEAD.exec(line)
  if (!m) return null
  const [, ts, rest] = m as unknown as [string, string, string]
  if (rest === TERMINAL_TYPED_LOG) return { ts, delivery: 'terminal' }
  if (rest === TERMINAL_DIALOG_LOG) return { ts, delivery: 'dialog' }
  if (PARKED_LOG.test(rest)) return { ts, delivery: 'parked' }
  if (/^(?:claude|codex|opencode) \[/.test(rest)) return { ts, delivery: 'process' }
  const hit = DELIVERY_LOG_HEADS.find(([prefix]) => rest.startsWith(prefix))
  return hit ? { ts, delivery: hit[1] } : null
}

/** その日が属する週の月曜（`YYYY-MM-DD`） */
export function weekOf(date: string): string {
  const at = Date.parse(`${date}T00:00:00Z`)
  const back = (new Date(at).getUTCDay() + 6) % 7
  return new Date(at - back * 86_400_000).toISOString().slice(0, 10)
}

const addDays = (date: string, days: number): string => new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10)

/** 範囲を指定しないときの範囲: 今週を含む `PATHS_WEEKS` 週ぶんの月曜から今日まで */
export function pathsRange(now: Date): DateRange {
  const { to } = dateRange({}, now)
  return { from: addDays(weekOf(to), -7 * (PATHS_WEEKS - 1)), to }
}

export interface AgentTurns {
  agent: string
  in_pane: number
  outside: number
}

export interface WeekPaths {
  /** 週の月曜 */
  week: string
  /** 範囲が週の途中で切れている（今週など） */
  partial: boolean
  /** エージェントの名前の順 */
  turns: AgentTurns[]
  in_pane: number
  outside: number
  deliveries: {
    /** 端末に打ち込んだ数。**記録を始める前の週は null**（0 と混ぜない） */
    terminal: number | null
    process: number
    app_server: number
    queue: number
    /** 端末に打ち込めず、別プロセスを起こさずに預かった数（下限の目安。`PARKED_LOG`） */
    parked: number
  }
  /** 端末のダイアログに SAI から答えた数。**記録を始める前の週は null** */
  dialogs: number | null
}

export interface PathsInput {
  /** 記録の行（範囲の外が混ざっていてよい） */
  rows: readonly FeedRow[]
  /** `reply.log` の全部（記録が始まった週を決めるので、範囲で絞らずに渡す） */
  deliveries: readonly DeliveryEntry[]
  range: DateRange
}

/** 週ごとに数える。古い順で、行が 1 つも無い週も出す */
export function weeklyPaths({ rows, deliveries, range }: PathsInput): WeekPaths[] {
  // 行を書き始めた週は途中からしか記録が無いので、数えるのは次の週から
  const firstWeek = (delivery: Delivery): string | undefined => deliveries.filter((d) => d.delivery === delivery).map((d) => weekOf(localDate(d.ts))).sort()[0]
  const startsAfter = (first: string | undefined, week: string): 0 | null => (first !== undefined && week > first ? 0 : null)
  const terminalAt = firstWeek('terminal')
  const dialogAt = firstWeek('dialog')
  const weeks = new Map<string, WeekPaths>()
  for (const date of datesBetween(range.from, range.to)) {
    const week = weekOf(date)
    if (weeks.has(week)) continue
    weeks.set(week, {
      week,
      partial: week < range.from || addDays(week, 6) > range.to,
      turns: [],
      in_pane: 0,
      outside: 0,
      deliveries: { terminal: startsAfter(terminalAt, week), process: 0, app_server: 0, queue: 0, parked: 0 },
      dialogs: startsAfter(dialogAt, week),
    })
  }
  const weekAt = (ts: string): WeekPaths | undefined => (inRange(ts, range) ? weeks.get(weekOf(localDate(ts))) : undefined)
  for (const row of rows) {
    const w = isTurn(row) ? weekAt(String(row.ts ?? '')) : undefined
    if (!w) continue
    const agent = row.agent || 'unknown'
    let t = w.turns.find((x) => x.agent === agent)
    if (!t) w.turns.push((t = { agent, in_pane: 0, outside: 0 }))
    const side = row.pane ? 'in_pane' : 'outside'
    t[side] += 1
    w[side] += 1
  }
  for (const d of deliveries) {
    const w = weekAt(d.ts)
    if (!w) continue
    if (d.delivery === 'terminal') {
      if (w.deliveries.terminal !== null) w.deliveries.terminal += 1
    } else if (d.delivery === 'dialog') {
      if (w.dialogs !== null) w.dialogs += 1
    } else w.deliveries[d.delivery] += 1
  }
  const out = [...weeks.values()]
  for (const w of out) w.turns.sort((a, b) => (a.agent < b.agent ? -1 : 1))
  return out
}

/**
 * `reply.log` の届け方の行を読む。子の出力も入っていて数百 MB になるので、1 行ずつ流して読む。無ければ空
 * （`readRows()` と同じく、読めないときは数えない）
 */
export async function readDeliveries(dir: string): Promise<DeliveryEntry[]> {
  const out: DeliveryEntry[] = []
  const input = createReadStream(join(dir, REPLY_LOG_FILE), { encoding: 'utf-8' })
  try {
    for await (const line of createInterface({ input, crlfDelay: Infinity })) {
      if (!line.startsWith('--- ')) continue
      const entry = deliveryOfLogLine(line)
      if (entry) out.push(entry)
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
  }
  return out
}
