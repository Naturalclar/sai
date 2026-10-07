// ターン完了（Stop）の行が落ちた・本文が空だったターンを、記録の行から見つける（#614）。
// 見つけるだけの純粋関数で、返答そのものは transcript から取る（`shared/claudeTurns.ts`、サーバの `server/local/recovered.ts`）。
// **JSONL には書かない**。補った行は応答に載せるだけで、`recovered: true` が付く
import { eventKind } from './events.ts'
import type { FeedRow } from './types.ts'
import { rowMs } from './unread.ts'

/** 補う候補 */
export type TurnGap =
  /** 入力の行のあとにターン完了の行が無い。`latest` は「そのあとに何も続いていない」= まだ回っているかもしれない */
  | { kind: 'missing'; input: FeedRow; latest: boolean }
  /** ターン完了の行はあるが本文が空（#613。締切に間に合わなかったときに書かれる行）。`input` は分かれば直前の入力の行 */
  | { kind: 'empty'; row: FeedRow; input?: FeedRow }

/** 候補の鍵（補った結果を覚える・rev に混ぜる）。同じ行は同じ鍵 */
export function gapKey(gap: TurnGap): string {
  const r = gap.kind === 'missing' ? gap.input : gap.row
  return `${gap.kind}|${r.session ?? ''}|${r.repo ?? ''}|${r.ts}`
}

const isInput = (r: FeedRow, kind: string) => kind === 'resume' && Boolean(r.user_text?.trim())

/**
 * 行（ts 順）から候補を拾う。**Claude の、このマシンの、ID の取れているセッションだけ**（transcript を引けるもの）。
 * - セッション単位で見る（エンティティではなく）。ターンの途中で別の worktree に移ると、ターン完了の行は別のエンティティに載る
 * - 入力の行（`resume` で `user_text` のあるもの）のあと、次の入力の行までにターン完了の行が無ければ `missing`
 * - ターン完了の行の本文が空なら `empty`
 */
export function turnGaps(rows: readonly FeedRow[], isRemote: (host: string | undefined) => boolean): TurnGap[] {
  const gaps: TurnGap[] = []
  const pending = new Map<string, FeedRow>()
  for (const r of rows) {
    if (r.agent !== 'claude' || !r.session || r.session_source !== 'payload' || isRemote(r.host)) continue
    const kind = eventKind(r.event, r.text)
    const open = pending.get(r.session)
    if (kind === 'turn') {
      if (!r.text?.trim()) gaps.push({ kind: 'empty', row: r, ...(open ? { input: open } : {}) })
      pending.delete(r.session)
    } else if (isInput(r, kind)) {
      if (open) gaps.push({ kind: 'missing', input: open, latest: false })
      pending.set(r.session, r)
    }
  }
  for (const input of pending.values()) gaps.push({ kind: 'missing', input, latest: true })
  return gaps
}

/** 行の ts と同じ形（秒まで・同じオフセット）にする。`sample` はそのセッションの行の ts */
export function tsLike(ms: number, sample: string): string {
  const m = /([+-])(\d{2}):?(\d{2})$/.exec(sample)
  const offsetMin = m ? (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3])) : 0
  const shifted = new Date(ms + offsetMin * 60_000).toISOString().replace(/\.\d{3}Z$/, '')
  return `${shifted}${m ? `${m[1]}${m[2]}:${m[3]}` : '+00:00'}`
}

/** 補える本文の上限（`record.py` の本文の上限と同じ） */
export const RECOVERED_TEXT_MAX = 20000

const clipText = (text: string) => (text.length > RECOVERED_TEXT_MAX ? text.slice(0, RECOVERED_TEXT_MAX) : text)

/**
 * 落ちたターン完了の行の代わりに応答へ載せる行。入力の行の身元（セッション・worktree・ブランチ…）を引き継ぎ、
 * 時刻は transcript でそのターンが閉じた時刻（入力の行より前にはしない）。`recovered: true` で見分ける
 */
export function recoveredRow(input: FeedRow, text: string, endedMs: number, authFailed = false): FeedRow {
  const at = Math.max(endedMs, rowMs(input.ts) + 1000)
  return { ...input, ts: tsLike(at, input.ts), event: 'Stop', text: clipText(text), recovered: true, ...(authFailed ? { recovered_auth_failed: true as const } : {}) }
}

/** 本文が空のターン完了の行に、補った本文を載せた写し（元の行は書き換えない） */
export function filledRow(row: FeedRow, text: string, authFailed = false): FeedRow {
  return { ...row, text: clipText(text), recovered: true, ...(authFailed ? { recovered_auth_failed: true as const } : {}) }
}

/**
 * 候補に補った本文を当てて、応答に載せる行の並びを作る。補うものが無ければ**同じ配列をそのまま返す**。
 * `resolved` は候補の鍵 → 補った結果（無いものは補わない）
 */
export function applyRecovered(rows: readonly FeedRow[], gaps: readonly TurnGap[], resolved: ReadonlyMap<string, { text: string; endedMs: number; authFailed?: true }>): readonly FeedRow[] {
  const filled = new Map<FeedRow, FeedRow>()
  const added: FeedRow[] = []
  for (const gap of gaps) {
    const got = resolved.get(gapKey(gap))
    if (!got?.text.trim()) continue
    if (gap.kind === 'empty') filled.set(gap.row, filledRow(gap.row, got.text, got.authFailed))
    else added.push(recoveredRow(gap.input, got.text, got.endedMs, got.authFailed))
  }
  if (filled.size === 0 && added.length === 0) return rows
  const out = rows.map((r) => filled.get(r) ?? r).concat(added)
  // store と同じ並べ方（ts の文字列。sort は安定なので、同じ ts は元の行が先）
  return out.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0))
}
