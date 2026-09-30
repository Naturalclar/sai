// 未読の印（#502）。セッションごとに「読んだ最後のターン完了の時刻」を 1 つだけ持つ（行ごとには持たない）。
// 置き場は `<feed dir>/read-marks.json`（server/meta/reads.ts）。ここはサーバと画面が共用する純粋関数だけ
import { entityId } from './entity.ts'
import { eventKind } from './events.ts'
import type { FeedRow } from './types.ts'

/**
 * 既読の印のファイルの中身。`since` は初めて印を持った時刻（ミリ秒）で、**印の無いセッションはここまで読んだ扱い**にする。
 * 無いと、入れた瞬間に 7 日ぶんの全ターンが未読になる
 */
export interface ReadMarks {
  since: number
  /** エンティティ ID → 読んだ最後のターン完了の時刻（ミリ秒） */
  sessions: Record<string, number>
}

/** そのセッションをどこまで読んだか（ミリ秒）。印が無ければ `since` */
export function readMarkOf(marks: ReadMarks, id: string): number {
  return marks.sessions[id] ?? marks.since
}

/** 行の時刻（ミリ秒）。読めなければ NaN（どの比較にも当たらない） */
export function rowMs(ts: string | undefined): number {
  return ts ? Date.parse(ts) : NaN
}

/**
 * 未読に数える行。**エージェントのターン完了だけ**（待ち・入力・終わりの行は、読むべき返答ではない）。
 * 待ちは「相手が人を待っている」別の軸で、すでに印が出る
 */
export function isUnreadCandidate(r: FeedRow): boolean {
  return eventKind(r.event, r.text) === 'turn'
}

/** セッションごとの未読の数。印より新しいターン完了の行を数える（0 のセッションは入れない） */
export function unreadCounts(rows: readonly FeedRow[], marks: ReadMarks): Map<string, number> {
  const out = new Map<string, number>()
  for (const r of rows) {
    if (!isUnreadCandidate(r)) continue
    const id = entityId(r.session ?? '', r.repo ?? '', String(r.ts ?? ''))
    if (rowMs(r.ts) > readMarkOf(marks, id)) out.set(id, (out.get(id) ?? 0) + 1)
  }
  return out
}

/** そのセッションの一番新しいターン完了の時刻（ミリ秒）。無ければ NaN */
export function latestTurnMs(rows: readonly FeedRow[]): number {
  let latest = NaN
  for (const r of rows) {
    if (!isUnreadCandidate(r)) continue
    const ms = rowMs(r.ts)
    if (!(ms <= latest)) latest = ms
  }
  return latest
}

/**
 * 「ここから未読にする」で置く印。その発言の**1 秒前**（行の `ts` は秒までなので、同じ秒の発言を読んだ扱いにしない）
 */
export function unreadFromMark(ts: string): number {
  return rowMs(ts) - 1000
}

/**
 * 印を進めてよいか。**既読は後ろに戻さない**（別の端末で先まで読んだのを、古い画面の自動の既読で巻き戻さない）。
 * 戻すのは「ここから未読にする」（`back`）だけ
 */
export function nextMark(current: number, wanted: number, back: boolean): number | null {
  if (!Number.isFinite(wanted)) return null
  if (back) return wanted === current ? null : wanted
  return wanted > current ? wanted : null
}
