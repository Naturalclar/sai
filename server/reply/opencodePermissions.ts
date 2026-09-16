// OpenCode の許可待ちを画面のバブルに載せ、押された答えを本体に返す（#421）。
//
// `codexDialogs.ts` と同じ位置づけ（画面の 3 秒のポーリングのついでに 1 本だけ引く）だが、あちらが
// 「ダイアログが出ていることしか分からないので答えは端末に任せる」のに対し、**こちらは答えられる**
// （`POST /session/<id>/permissions/<permissionId>` があり、実機で 1 往復して確かめた）。
//
// 答える口は画面の既存の `POST /api/approvals/<id>/answer`（同一オリジンのみ）に相乗りする。新しい API は作らない。
import { permissionApprovalId, permissionApprovals, permissionResponse } from '../../shared/opencodePermissions.ts'
import type { OpencodePermission } from '../../shared/opencodePermissions.ts'
import type { ApprovalAnswer, ApprovalMap, SessionSummary } from '../../shared/types.ts'
import type { OpencodeApp } from './opencodeServer.ts'
import { sessionOf } from '../local/progress.ts'

/** 答えた結果。`codexAppServer.ts` の `CodexAnswerResult` と同じ形にして、app.ts の分岐を揃える */
export type OpencodeAnswerResult = { ok: true } | { ok: false; status: number; error: string }

export class OpencodePermissions {
  private readonly app: OpencodeApp
  private readonly now: () => number
  /** approval_id → その許可（答えるときに使う）。保留から消えたら落とす */
  private active = new Map<string, OpencodePermission>()
  /** 許可の id → 最初に見かけた時刻。保留そのものに時刻が載っていないので、こちらで覚える */
  private seen = new Map<string, string>()
  private scanning: Promise<ApprovalMap> | null = null

  constructor(app: OpencodeApp, now: () => number = Date.now) {
    this.app = app
    this.now = now
  }

  /**
   * いま答えを待っている許可を、エンティティごとの `Approval` にする。
   * **同時に何本も引かない**（3 つの応答（一覧・詳細・フィード）が同じ瞬間に来るので、1 本にまとめる）
   */
  async scan(sessions: readonly SessionSummary[]): Promise<ApprovalMap> {
    if (!this.app.permissions) return {}
    this.scanning ??= this.scanNow(sessions).finally(() => {
      this.scanning = null
    })
    return this.scanning
  }

  private async scanNow(sessions: readonly SessionSummary[]): Promise<ApprovalMap> {
    // 記録にある OpenCode のセッションだけに当てる（サーバは SAI 以外が作ったセッションの保留も返しうる）
    const bySession = new Map<string, string>()
    // 聞きに行く cwd（`GET /permission` は `directory` が要る。#393 / #394 と同じ）。
    // **SAI が回しているターン**（答えられるのはその分だけ）と、**行の上で待っているセッション**の cwd だけを見る。
    // 普段は 0〜1 件で、どちらでもなければ 1 本も投げない
    const dirs = new Set<string>()
    for (const s of sessions) {
      if (s.agent !== 'opencode') continue
      const session = sessionOf(s)
      if (session) bySession.set(session, s.id)
      if (s.cwd && (this.app.running(s.id) || s.waiting)) dirs.add(s.cwd)
    }
    const pending = dirs.size === 0 ? [] : await this.app.permissions!([...dirs]).catch(() => [])
    const map = permissionApprovals(
      pending,
      (sessionID) => bySession.get(sessionID),
      (id) => this.since(id),
    )
    // 出したものだけを覚える（答えられるのはバブルに出ているものだけ）
    const next = new Map<string, OpencodePermission>()
    for (const list of Object.values(map)) {
      for (const approval of list) {
        const hit = pending.find((p) => permissionApprovalId(p.id) === approval.approval_id)
        if (hit) next.set(approval.approval_id, hit)
      }
    }
    this.active = next
    // 消えた保留の「最初に見かけた時刻」は落とす（同じ id は二度と来ない）
    const alive = new Set(pending.map((p) => p.id))
    for (const id of [...this.seen.keys()]) if (!alive.has(id)) this.seen.delete(id)
    return map
  }

  /** その approval_id が OpenCode の許可か（app.ts の分岐用） */
  has(approvalId: string): boolean {
    return this.active.has(approvalId)
  }

  /** 画面から押された答えを本体に返す。**提示した選択肢だけ**受け付ける */
  async answer(approvalId: string, answer: ApprovalAnswer): Promise<OpencodeAnswerResult> {
    const entry = this.active.get(approvalId)
    if (!entry) return { ok: false, status: 404, error: 'approval not found' }
    if (!this.app.answerPermission) return { ok: false, status: 409, error: 'OpenCode に答える口がありません' }
    const response = permissionResponse(answer.decision, answer.behavior)
    if (!response) return { ok: false, status: 400, error: '提示されていない選択です' }
    const ok = await this.app.answerPermission(entry.sessionID, entry.id, response).catch(() => false)
    // 届かなかった（サーバが落ちた・保留がもう無い）ときは消しておく。次のポーリングでバブルも消える
    if (!ok) {
      this.active.delete(approvalId)
      return { ok: false, status: 409, error: 'この許可はもう答えられません（OpenCode 側から消えています）' }
    }
    this.active.delete(approvalId)
    return { ok: true }
  }

  private since(permissionId: string): string {
    const seen = this.seen.get(permissionId)
    if (seen) return seen
    const ts = new Date(this.now()).toISOString()
    this.seen.set(permissionId, ts)
    return ts
  }
}
