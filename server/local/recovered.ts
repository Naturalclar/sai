// ターン完了（Stop）の行が落ちた・本文が空だったターンの返答を、transcript から補う（#614）。
// **JSONL には書かない**。行の並びに重ねて応答に載せるだけ（`recovered: true`）で、`turns` の集計にも入らない。
//
// 読むのは候補のときだけ（`shared/recoveredTurns.ts` の `turnGaps()`。ポーリングのたびに全セッションの transcript を読まない。#592）:
// - 最後のターン（そのあとに行が続いていない）は transcript の**末尾だけ**を読む。まだ回っているかもしれないので、
//   SAI が回している間・閉じてから 60 秒たつまでは補わない（「完了の記録なし」の印と同じ条件）
// - もう終わった古いターンは頭から読む。重いので**応答は待たせず**裏で 1 つずつ読み、読めたら次の応答から載る。結果は覚える
import { createHash } from 'node:crypto'
import { findTurn } from '../../shared/claudeTurns.ts'
import type { ClaudeTurn } from '../../shared/claudeTurns.ts'
import { entityId } from '../../shared/entity.ts'
import { applyRecovered, gapKey, turnGaps } from '../../shared/recoveredTurns.ts'
import type { TurnGap } from '../../shared/recoveredTurns.ts'
import { STOP_MISSING_AFTER_MS } from '../../shared/stopMissing.ts'
import type { FeedRow } from '../../shared/types.ts'
import { rowMs } from '../../shared/unread.ts'
import type { ProgressReader } from './progress.ts'

interface Found {
  text: string
  endedMs: number
}

export interface RecoveredDeps {
  /** その行は別のマシンのものか（transcript が手元に無い） */
  isRemote: (host: string | undefined) => boolean
  /** SAI がそのエンティティの返信を回しているか（回している間は補わない） */
  busy: (entity: string) => boolean
  now?: () => number
}

/** 閉じていなかった最後のターンを、transcript が変わっていなくても見直す間隔（閉じてから 60 秒の待ちが明けるのを拾う） */
const RETRY_MS = 15_000
/** 頭から読んでも決まらなかった候補を、もう一度頭から読むまでの間隔 */
const FULL_RETRY_MS = 5 * 60_000

export class RecoveredTurns {
  private readonly progress: ProgressReader
  private readonly deps: RecoveredDeps
  private readonly now: () => number
  /** 候補の鍵 → 決まった結果（補えない、も決まった結果。もう変わらないものだけ） */
  private readonly settled = new Map<string, Found | null>()
  /** まだ決まらない候補 → 見たときの transcript の印と時刻 */
  private readonly waiting = new Map<string, { sig: string; at: number; closing: boolean }>()
  /** 頭から読んでも決まらなかった候補 → 読んだ時刻（回っているセッションの transcript を 15 秒ごとに頭から読み直さない） */
  private readonly fullAt = new Map<string, number>()
  /** 裏で頭から読む順番待ち（鍵で 1 回だけ） */
  private readonly queued = new Set<string>()
  private chain: Promise<void> = Promise.resolve()

  constructor(progress: ProgressReader, deps: RecoveredDeps) {
    this.progress = progress
    this.deps = deps
    this.now = deps.now ?? Date.now
  }

  /**
   * 行の並びに補った行を重ねる。補うものが無ければ同じ配列を返す。
   * `key` は重ねたものの印（rev に混ぜる。補った行が増えたら画面が取り直す）
   */
  async apply(rows: readonly FeedRow[]): Promise<{ rows: readonly FeedRow[]; key: string }> {
    const gaps = turnGaps(rows, this.deps.isRemote)
    if (gaps.length === 0) return { rows, key: '' }
    const resolved = new Map<string, Found>()
    for (const gap of gaps) {
      const key = gapKey(gap)
      const got = this.settled.has(key) ? this.settled.get(key) : await this.look(gap, key)
      if (got) resolved.set(key, got)
    }
    if (resolved.size === 0) return { rows, key: '' }
    const key = createHash('sha1').update([...resolved.keys()].sort().join('\n')).digest('hex').slice(0, 10)
    return { rows: applyRecovered(rows, gaps, resolved), key }
  }

  /** 裏で読んでいるものが終わるのを待つ（テスト用。応答はこれを待たない） */
  async idle(): Promise<void> {
    await this.chain
  }

  private async look(gap: TurnGap, key: string): Promise<Found | null> {
    const row = gap.kind === 'missing' ? gap.input : gap.row
    const session = row.session ?? ''
    const cwd = row.cwd ?? ''
    const now = this.now()
    if (gap.kind === 'missing' && !gap.latest) {
      // もう終わったターン。頭から読むので裏に回す
      this.later(key, session, cwd, gap)
      return null
    }
    if (gap.kind === 'missing') {
      if (now - rowMs(row.ts) < STOP_MISSING_AFTER_MS) return null
      if (this.deps.busy(entityId(session, row.repo ?? '', row.ts))) return null
    }
    // **読む前に**間引く（#627 のレビュー。決まらない候補 = 長く回っている端末のターン・途中で落ちたセッション・閉じた本文の無い
    // 空の行、を 3 秒のポーリングのたびに読まない。#592）: 見てから RETRY_MS は読まず、そのあとも transcript が変わっておらず
    // 「閉じたのを待っているだけ」でもなければ読まない
    const seen = this.waiting.get(key)
    if (seen && now - seen.at < RETRY_MS) return null
    if (seen && !seen.closing) {
      const sig = await this.progress.claudeSig(session, cwd)
      if (sig === seen.sig) {
        seen.at = now
        return null
      }
    }
    const tail = await this.progress.claudeTurns(session, cwd, false)
    if (!tail) {
      this.waiting.set(key, { sig: '', at: now, closing: false })
      return null
    }
    const turn = findTurn(tail.turns, this.target(gap))
    const got = turn ? this.judge(turn, now) : undefined
    if (got !== undefined) {
      this.waiting.delete(key)
      this.settled.set(key, got)
      return got
    }
    // 閉じているが 60 秒の待ちが明けていないだけなら、transcript が変わらなくても次は読む
    this.waiting.set(key, { sig: tail.sig, at: now, closing: Boolean(turn?.closed) })
    // 末尾に見当たらない = そのあとに別の入力（タスクの通知・割り込み）が続いている。頭から読めば見つかる
    if (!turn && tail.turns.length > 0) this.later(key, session, cwd, gap)
    return null
  }

  private target(gap: TurnGap): { startMs?: number; endMs?: number; input?: string } {
    if (gap.kind === 'missing') return { startMs: rowMs(gap.input.ts), input: gap.input.user_text ?? '' }
    return gap.input ? { startMs: rowMs(gap.input.ts), input: gap.input.user_text ?? '' } : { endMs: rowMs(gap.row.ts), input: gap.row.user_text ?? '' }
  }

  /**
   * そのターンから補えるか。決まれば結果（補えないなら null）、まだ決まらなければ undefined。
   * 閉じていて本文があれば補う（続きが無いときは、本物の行が来るのを 60 秒待ってから）。閉じないまま次の入力が来ていれば補えない
   */
  private judge(turn: ClaudeTurn, now: number): Found | null | undefined {
    const endedMs = Date.parse(turn.endedAt)
    if (turn.closed && turn.text && Number.isFinite(endedMs)) {
      if (turn.over || now - endedMs >= STOP_MISSING_AFTER_MS) return { text: turn.text, endedMs }
      return undefined
    }
    return turn.over ? null : undefined
  }

  private later(key: string, session: string, cwd: string, gap: TurnGap): void {
    if (this.queued.has(key) || this.settled.has(key)) return
    const tried = this.fullAt.get(key)
    if (tried !== undefined && this.now() - tried < FULL_RETRY_MS) return
    this.fullAt.set(key, this.now())
    this.queued.add(key)
    this.chain = this.chain
      .then(async () => {
        const full = await this.progress.claudeTurns(session, cwd, true)
        // transcript が無い・読めないときは決めない（次に候補に挙がったときにまた試す。探し直しの間隔は ProgressReader が持つ）
        if (!full) return
        const turn = findTurn(full.turns, this.target(gap))
        const got = turn ? this.judge(turn, this.now()) : null
        if (got !== undefined) {
          this.settled.set(key, got)
          this.fullAt.delete(key)
        }
      })
      .catch(() => undefined)
      .finally(() => {
        this.queued.delete(key)
      })
  }
}
