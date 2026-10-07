// 預かっている待ち（#732）の置き場。決まりごと（検査・上限・起こすときの本文）は `shared/waits.ts`、
// 確かめる・起こすのは app.ts の `tickWaits()`。ここは持つだけ。
//
// メモリだけだと、サーバの立て直しで待ちが黙って消える（エージェントには「預かった」と返してある）。ループと同じく
// `<feed dir>/waits.json` にも書き、起動時に読み戻す。**起こす前に「起こしている」を書く**ので、その途中で立て直されたものは
// 届いたか分からない。送り直さず、理由を付けて止める（二重に起こさない）
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { WAIT_DAY_MS, WAIT_KEEP_MS, waitLive, waitView } from '../../shared/waits.ts'
import type { WaitState } from '../../shared/waits.ts'
import type { WaitMap, WaitResult, WaitStatus } from '../../shared/types.ts'

export const WAITS_FILE = 'waits.json'

/** サーバが待ちを見に行く間隔（`gh` を叩く間隔は待ちごとの `next_check_at`。こちらは時刻が来たかを見るだけ） */
export const WAIT_TICK_MS = 5_000

/** 起こしている途中で立て直された待ちに付ける理由 */
export const WAIT_HALTED_ON_RESTART = '起こしている途中でサーバが立て直されました。届いたか分からないので、起こし直していません'

const STATUSES: readonly WaitStatus[] = ['waiting', 'ready', 'waking', 'expired', 'halted']
const RESULTS: readonly WaitResult[] = ['success', 'failure', 'none', 'merged', 'closed']

/** ファイルの 1 件を検査する。形が合わなければ null（壊れたファイルでサーバを落とさない） */
function stateFrom(v: unknown): WaitState | null {
  if (!v || typeof v !== 'object') return null
  const r = v as Partial<WaitState>
  const strings = [r.id, r.repo, r.then, r.since, r.deadline].every((x) => typeof x === 'string' && x)
  if (!strings || typeof r.pr !== 'number' || !Number.isInteger(r.pr) || r.pr <= 0 || !STATUSES.includes(r.status as WaitStatus)) return null
  return {
    id: r.id!,
    repo: r.repo!,
    pr: r.pr,
    then: r.then!,
    status: r.status!,
    since: r.since!,
    deadline: r.deadline!,
    ...(RESULTS.includes(r.result as WaitResult) ? { result: r.result! } : {}),
    ...(typeof r.reason === 'string' && r.reason ? { reason: r.reason } : {}),
    ...(typeof r.checked_at === 'string' && r.checked_at ? { checked_at: r.checked_at } : {}),
    ...(typeof r.next_check_at === 'string' && r.next_check_at ? { next_check_at: r.next_check_at } : {}),
    ...(Array.isArray(r.failing) ? { failing: r.failing.filter((x): x is string => typeof x === 'string') } : {}),
    ...(typeof r.url === 'string' ? { url: r.url } : {}),
    ...(r.seen_once === 'success' || r.seen_once === 'failure' ? { seen_once: r.seen_once } : {}),
  }
}

interface Persisted {
  waits: Record<string, unknown[]>
  wakes: Record<string, unknown[]>
}

export class WaitStore {
  /** エンティティID → 待ち（古い順） */
  private waits = new Map<string, WaitState[]>()
  /** エンティティID → 自動で起こした時刻（ms）。1 日の回数の上限に使う */
  private wakes = new Map<string, number[]>()
  /** 預かった・進んだ・止めた・起こしたで進める（rev に混ぜる） */
  private version = 0
  readonly path: string | null

  /** path があればそこにも書き、起動時に読み戻す。null ならメモリだけ */
  constructor(path: string | null) {
    this.path = path
    this.load()
  }

  private load(): void {
    if (!this.path) return
    let raw: Partial<Persisted> | null
    try {
      raw = JSON.parse(readFileSync(this.path, 'utf-8')) as Partial<Persisted> | null
    } catch {
      return
    }
    if (!raw || typeof raw !== 'object') return
    let halted = false
    for (const [id, list] of Object.entries(raw.waits && typeof raw.waits === 'object' ? raw.waits : {})) {
      if (!Array.isArray(list)) continue
      // 終わったまま人が片付けなかった待ちは、古くなったら落とす（開かれないセッションの分が溜まり続けない）
      const states = list.map(stateFrom).filter((w): w is WaitState => w !== null && (waitLive(w.status) || Date.parse(w.deadline) > Date.now() - WAIT_KEEP_MS))
      // 起こしている途中で落ちたものは、届いたか分からない。送り直さない
      const kept = states.map((w): WaitState => {
        if (w.status !== 'waking') return w
        halted = true
        return { ...w, status: 'halted', reason: WAIT_HALTED_ON_RESTART }
      })
      if (kept.length > 0) this.waits.set(id, kept)
    }
    for (const [id, list] of Object.entries(raw.wakes && typeof raw.wakes === 'object' ? raw.wakes : {})) {
      const recent = Array.isArray(list) ? list.filter((x): x is number => typeof x === 'number' && Number.isFinite(x) && x > Date.now() - WAIT_DAY_MS) : []
      if (recent.length > 0) this.wakes.set(id, recent)
    }
    if (halted) this.persist()
  }

  /**
   * いまの中身を書く。tmp → rename（loops.json と同じ）。書けなくてもメモリで続く。
   * `quiet` は画面に出ない項目（次に確かめる時刻など）だけが変わったとき: 書くが、rev は進めない（毎分の確かめで画面を描き直させない）
   */
  private persist(quiet = false): void {
    if (!quiet) this.version++
    if (!this.path) return
    try {
      mkdirSync(dirname(this.path), { recursive: true })
      const tmp = `${this.path}.${process.pid}.tmp`
      const body: Persisted = { waits: Object.fromEntries(this.waits), wakes: Object.fromEntries(this.wakes) }
      writeFileSync(tmp, JSON.stringify(body, null, 2) + '\n', { mode: 0o600 })
      renameSync(tmp, this.path)
    } catch {
      // 書けなくてもメモリで続く
    }
  }

  /** そのセッションの待ち（古い順） */
  of(id: string): WaitState[] {
    return this.waits.get(id) ?? []
  }

  get(id: string, waitId: string): WaitState | undefined {
    return this.of(id).find((w) => w.id === waitId)
  }

  add(id: string, wait: WaitState): void {
    this.waits.set(id, [...this.of(id), wait])
    this.persist()
  }

  /** 同じ id の待ちを置き換える。もう無ければ何もしない（その間に人が止めた）。画面に出る形が変わらなければ rev は進めない */
  set(id: string, wait: WaitState): boolean {
    const list = this.of(id)
    const before = list.find((w) => w.id === wait.id)
    if (!before) return false
    this.waits.set(id, list.map((w) => (w.id === wait.id ? wait : w)))
    this.persist(JSON.stringify(waitView(before)) === JSON.stringify(waitView(wait)))
    return true
  }

  remove(id: string, waitId: string): boolean {
    const list = this.of(id)
    const rest = list.filter((w) => w.id !== waitId)
    if (rest.length === list.length) return false
    if (rest.length > 0) this.waits.set(id, rest)
    else this.waits.delete(id)
    this.persist()
    return true
  }

  /** 自動で起こしたことを数える */
  woke(id: string, at: number): void {
    this.wakes.set(id, [...this.wakesOf(id, at), at])
    this.persist()
  }

  /** 直近 24 時間に自動で起こした時刻 */
  wakesOf(id: string, now: number): number[] {
    return (this.wakes.get(id) ?? []).filter((at) => at > now - WAIT_DAY_MS)
  }

  /** 見に行く相手（確かめている・起こす前のもの） */
  live(): [string, WaitState][] {
    return [...this.waits].flatMap(([id, list]) => list.filter((w) => waitLive(w.status)).map((w): [string, WaitState] => [id, w]))
  }

  /** 画面に出す形 */
  snapshot(): WaitMap {
    return Object.fromEntries([...this.waits].map(([id, list]) => [id, list.map(waitView)]))
  }

  key(): string {
    return String(this.version)
  }
}
