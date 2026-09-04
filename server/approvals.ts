// 返信中の許可・質問の預かり所。正本はメモリ。
//
//   claude -p --permission-prompt-tool mcp__sai__approve
//     → server/approve-mcp.ts（子プロセス）が POST /api/approvals で預けて、GET /api/approvals/<id>?wait=1 で答えを待つ
//     → 画面が POST /api/approvals/<id>/answer で答える
//
// 返信のプロセスが exit したら（runner の release）そのエンティティの分は deny で片付ける。
// MCP 側が取りに来なくなったもの（CLI が落ちた）は STALE_MS で捨てる
import { randomBytes } from 'node:crypto'
import { approvalText } from '../shared/approvals.ts'
import type { Approval, ApprovalAnswer, ApprovalMap } from '../shared/types.ts'

/** MCP 側の長いポーリング1回の上限 */
export const WAIT_MS = 20_000
/** これだけ取りに来なければ CLI はもういない */
export const STALE_MS = 90_000

interface Entry {
  approval: Approval
  answer: ApprovalAnswer | null
  lastPolled: number
  waiters: ((a: ApprovalAnswer | null) => void)[]
}

export class Approvals {
  private entries = new Map<string, Entry>()
  private readonly now: () => number

  constructor(now: () => number = Date.now) {
    this.now = now
  }

  /** 預ける。approval_id を返す */
  ask(id: string, toolName: string, input: Record<string, unknown>, toolUseId: string): Approval {
    const approval: Approval = {
      approval_id: randomBytes(8).toString('hex'),
      id,
      since: new Date(this.now()).toISOString(),
      tool_name: toolName,
      input,
      tool_use_id: toolUseId,
      text: approvalText(toolName, input),
    }
    this.entries.set(approval.approval_id, { approval, answer: null, lastPolled: this.now(), waiters: [] })
    return approval
  }

  get(approvalId: string): Approval | undefined {
    return this.entries.get(approvalId)?.approval
  }

  /** 答える。無い・答え済みなら false */
  answer(approvalId: string, answer: ApprovalAnswer): boolean {
    const e = this.entries.get(approvalId)
    if (!e || e.answer) return false
    e.answer = answer
    for (const w of e.waiters) w(answer)
    e.waiters = []
    return true
  }

  /**
   * 答えを待つ（MCP 側）。答え済みならすぐ、そうでなければ ms まで待って null。
   * 答えを渡したらエントリは消す（CLI に届いたので、もう画面に出さない）
   */
  async wait(approvalId: string, ms: number = WAIT_MS): Promise<ApprovalAnswer | null | undefined> {
    const e = this.entries.get(approvalId)
    if (!e) return undefined
    e.lastPolled = this.now()
    const answer =
      e.answer ??
      (await new Promise<ApprovalAnswer | null>((resolve) => {
        const timer = setTimeout(() => {
          e.waiters = e.waiters.filter((w) => w !== done)
          resolve(null)
        }, ms)
        const done = (a: ApprovalAnswer | null) => {
          clearTimeout(timer)
          resolve(a)
        }
        e.waiters.push(done)
      }))
    if (answer) this.entries.delete(approvalId)
    else if (this.entries.get(approvalId) === e) e.lastPolled = this.now()
    return answer
  }

  /** 画面に出す分（答え待ちだけ）。エンティティごとに古い順 */
  snapshot(): ApprovalMap {
    this.sweep()
    const out: ApprovalMap = {}
    for (const e of this.entries.values()) {
      if (e.answer) continue
      ;(out[e.approval.id] ??= []).push(e.approval)
    }
    for (const list of Object.values(out)) list.sort((a, b) => (a.since < b.since ? -1 : a.since > b.since ? 1 : 0))
    return out
  }

  /** rev に混ぜる鍵。答え待ちの集合が変われば変わる */
  revKey(): string {
    return Object.values(this.snapshot())
      .flat()
      .map((a) => a.approval_id)
      .sort()
      .join(',')
  }

  /** そのエンティティの答え待ちを全部 deny で片付ける（返信のプロセスが終わった） */
  drop(id: string, message = '返信のプロセスが終わった'): number {
    let n = 0
    for (const [key, e] of this.entries) {
      if (e.approval.id !== id) continue
      if (!e.answer) this.answer(key, { behavior: 'deny', message })
      this.entries.delete(key)
      n++
    }
    return n
  }

  /** 取りに来なくなったものを捨てる */
  sweep(staleMs: number = STALE_MS): void {
    const cutoff = this.now() - staleMs
    for (const [key, e] of this.entries) {
      if (e.lastPolled < cutoff && e.waiters.length === 0) this.entries.delete(key)
    }
  }
}
