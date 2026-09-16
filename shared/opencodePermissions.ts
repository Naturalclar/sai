// OpenCode の許可待ち（#421）。保留の形を読み、待ちの 1 行にして、画面の `Approval` に載せる。
//
// 実機（1.18.30）で確かめた形。`GET /permission` の 1 件と、プラグインに届く `permission.asked` の
// `properties` は**同じ形**なので、文言を作る関数は 1 つで足りる（`feed/opencode/sai.js` が同じ規則を JS で持ち、
// `opencodePermissions.test.ts` と `server/opencodePlugin.test.ts` に**同じ入力と同じ期待文字列**を置いてある）。
//
// ```json
// {"id":"per_0a8ae76cb001yE6OKiZ7AnqswF","sessionID":"ses_…","permission":"external_directory",
//  "patterns":["/etc/*"],"metadata":{"filepath":"/etc/hosts","parentDir":"/etc"},
//  "always":["/etc/*"],"tool":{"messageID":"msg_…","callID":"call_…"}}
// ```
//
// **保留を引くのは v1 の `GET /permission` だけ**（実測: 実際のツールの許可は v1 の一覧にだけ出て、
// v2 の `GET /api/session/<id>/permission` は空だった。逆に v2 の口で作った要求は v2 にしか出ない）。
import { APPROVAL_TEXT_MAX } from './approvals.ts'
import type { Approval, ApprovalDecision, ApprovalMap } from './types.ts'

/** `GET /permission` の 1 件。要るところだけ */
export interface OpencodePermission {
  /** `per_…`。答えるときの鍵 */
  id: string
  /** `ses_…`。行の `session` と同じ */
  sessionID: string
  /** 何の許可か（`external_directory` / `bash` / `edit` …） */
  permission: string
  /** 「常に許可」にしたときに効く範囲（`/etc/*` など）。画面には出すが押せるようにはしない */
  patterns: string[]
  metadata: Record<string, unknown>
}

/**
 * 詳細に使うキー。**大文字小文字は無視する**（実物は `filepath` で、当てずっぽうで書いていた `filePath` では
 * 1 文字も拾えず、行が `許可待ち: external_directory` だけになっていた）。
 * 前から順に、最初に見つかった文字列を使う
 */
const DETAIL_KEYS = ['command', 'filepath', 'file_path', 'path', 'url', 'pattern', 'description', 'parentdir']

const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '')

/** 何を聞かれているか（`/etc/hosts`）。metadata から拾えなければ `patterns` の 1 つめ、それも無ければ空 */
export function permissionDetail(p: Pick<OpencodePermission, 'patterns' | 'metadata'>): string {
  const lower = new Map<string, unknown>()
  for (const [k, v] of Object.entries(p.metadata ?? {})) lower.set(k.toLowerCase(), v)
  for (const key of DETAIL_KEYS) {
    const v = str(lower.get(key))
    if (v) return v
  }
  return str((p.patterns ?? [])[0])
}

/**
 * 待ちの 1 行（`許可待ち: external_directory: /etc/hosts`）。
 * 頭の `許可待ち: ` は `record.py` の待ちの行・`shared/approvals.ts` の承認と同じ（3 つが同じ見た目になる）
 */
export function opencodePermissionText(p: Pick<OpencodePermission, 'permission' | 'patterns' | 'metadata'>): string {
  const kind = str(p.permission) || '許可'
  const detail = permissionDetail(p)
  const line = detail ? `${kind}: ${detail}` : kind
  const text = `許可待ち: ${line}`
  const chars = Array.from(text)
  return chars.length <= APPROVAL_TEXT_MAX ? text : chars.slice(0, APPROVAL_TEXT_MAX).join('')
}

/** `GET /permission` の応答を読む。形が違う分は落とす（id と sessionID が無ければ答えようがない） */
export function parsePermissions(body: unknown): OpencodePermission[] {
  if (!Array.isArray(body)) return []
  const out: OpencodePermission[] = []
  for (const item of body) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue
    const o = item as Record<string, unknown>
    const id = str(o.id)
    const sessionID = str(o.sessionID)
    if (!id || !sessionID) continue
    out.push({
      id,
      sessionID,
      permission: str(o.permission),
      patterns: Array.isArray(o.patterns) ? o.patterns.filter((v): v is string => typeof v === 'string') : [],
      metadata: o.metadata && typeof o.metadata === 'object' && !Array.isArray(o.metadata) ? (o.metadata as Record<string, unknown>) : {},
    })
  }
  return out
}

/**
 * 画面に出す選択肢。**「常に許可」（`always`）は出さない**（Codex に出していないのと同じ理由に加えて、
 * OpenCode の `always` は `patterns` の glob（`/etc/*`）に対して効くので、押した範囲が本人に見えない）。
 * `id` はそのまま OpenCode に渡す `response` の値で、**サーバは提示したものだけを受け付ける**
 */
export const OPENCODE_DECISIONS: readonly ApprovalDecision[] = [
  { id: 'once', label: '許可', behavior: 'allow' },
  { id: 'reject', label: '拒否', behavior: 'deny' },
]

/** その answer が選べるか（提示していない `always` を弾く）。返すのは OpenCode に渡す `response` */
export function permissionResponse(decision: string | undefined, behavior: 'allow' | 'deny'): 'once' | 'reject' | null {
  const hit = OPENCODE_DECISIONS.find((d) => d.id === decision)
  // 選択肢を送ってこない画面（古いビルド）でも、allow / deny だけで決められるようにする
  if (!hit) return decision === undefined ? (behavior === 'allow' ? 'once' : 'reject') : null
  return hit.behavior === behavior ? (hit.id as 'once' | 'reject') : null
}

/** 承認の id（`approval_id`）。OpenCode の許可の id がそのまま一意なので、見分けの接頭辞を付けるだけ */
export const permissionApprovalId = (permissionId: string): string => `opencode-${permissionId}`

/**
 * 保留をエンティティごとの `Approval` にする。`entityOf` は OpenCode のセッション ID からエンティティ ID を引く
 * （**行にあるセッションだけ**。SAI が起こしたサーバには、記録に無いセッションの保留が混ざりうる）。
 * `since` は「最初に見かけた時刻」を引く関数（保留そのものには時刻が載っていない）
 */
export function permissionApprovals(
  pending: readonly OpencodePermission[],
  entityOf: (sessionID: string) => string | undefined,
  since: (permissionId: string) => string,
): ApprovalMap {
  const out: ApprovalMap = {}
  for (const p of pending) {
    const id = entityOf(p.sessionID)
    if (!id) continue
    const approval: Approval = {
      approval_id: permissionApprovalId(p.id),
      id,
      since: since(p.id),
      tool_name: p.permission || 'permission',
      input: { ...p.metadata, ...(p.patterns.length ? { patterns: p.patterns } : {}) },
      tool_use_id: '',
      text: opencodePermissionText(p),
      agent: 'opencode',
      answerable: true,
      decisions: [...OPENCODE_DECISIONS],
    }
    const list = out[id]
    if (list) list.push(approval)
    else out[id] = [approval]
  }
  return out
}

// ---- 答える相手が消えた待ちを畳む（#422） ----

/** 保留を 1 回引いた結果。**引けなかったこと（`ok: false`）が分かる形にする**（材料が無いのに待ちを畳まないため） */
export interface PendingSnapshot {
  /** 聞けたか（サーバが立っていて、頼んだ `directory` を全部引けた） */
  ok: boolean
  /** 実際に聞いた `directory`（= セッションの cwd） */
  asked: ReadonlySet<string>
  /** いま保留を持っているセッション（`ses_…`） */
  sessions: ReadonlySet<string>
}

/** 空（まだ 1 回も引いていない）。`ok: false` なので、これだけでは何も畳まない */
export const NO_PENDING: PendingSnapshot = { ok: false, asked: new Set(), sessions: new Set() }

/**
 * その待ちを畳んでよいか（#422）。**呼ぶ側が「OpenCode・行の上で待っている・このマシン」に絞ってから渡す。**
 *
 * | 材料 | どうするか |
 * | --- | --- |
 * | いま保留がある | **残す**（この瞬間に答えられる。下の 2 つより先に見る） |
 * | 待ちの行を書いたプロセスが**もう居ない** | **畳む**（保留はそのプロセスのメモリにあるので、誰も答えられない） |
 * | 保留を引けて、その cwd も聞いていて、そのセッションの保留が**無い** | **畳む**（答えられる状態なら保留に必ず居る） |
 * | pid が分からない・引けなかった・聞いていない cwd | **残す**（#255 と同じで「分からないなら残す」） |
 *
 * **時間では畳まない**（「N 時間たったら」はただの当て推量で、端末で開いたまま人が席を外しているだけの
 * 待ちまで消してしまう）。`pidAlive` は `undefined` が「分からない」で、**その場合も残す**
 */
export function settlesWaiting(
  session: { session: string; cwd: string },
  pending: PendingSnapshot,
  pidAlive: boolean | undefined,
): boolean {
  // いま保留がある＝この瞬間に答えられるので、ほかに何があっても残す（古い行の死んだ pid より、いまの保留が正しい）
  if (pending.ok && pending.sessions.has(session.session)) return false
  if (pidAlive === false) return true
  if (pending.ok && session.cwd && pending.asked.has(session.cwd)) return true
  return false
}
