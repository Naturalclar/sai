// セッションに組んだループ（#634）の置き場。決まりごと（検査・周の文・周の終わりの状態）は `shared/loops.ts`、
// 起こす・止めるのは app.ts の `tickLoops()`。ここは持つだけ。
//
// メモリだけだと、サーバの立て直しで回っていたループが黙って消える。`replying.json` / `reply-queue.json` と同じく
// `<feed dir>/loops.json` にも書き、起動時に読み戻す。**周を送る前に「送った」を書く**ので、立て直しても同じ周を 2 回は送らない
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { loopView } from '../../shared/loops.ts'
import type { LoopState } from '../../shared/loops.ts'
import type { LoopMap, LoopStatus } from '../../shared/types.ts'

export const LOOPS_FILE = 'loops.json'

/** サーバが周を見に行く間隔（画面を開いていなくても回るように、ポーリングとは別に見る） */
export const LOOP_TICK_MS = 5_000

const STATUSES: readonly LoopStatus[] = ['running', 'paused', 'done', 'gave_up', 'stopped']

/** ファイルの 1 件を検査する。形が合わなければ null（壊れたファイルでサーバを落とさない） */
function stateFrom(v: unknown): LoopState | null {
  if (!v || typeof v !== 'object') return null
  const r = v as Partial<LoopState>
  const strings = [r.goal, r.until, r.deadline, r.since].every((x) => typeof x === 'string' && x)
  const numbers = [r.max_rounds, r.interval_s, r.round].every((x) => typeof x === 'number' && Number.isFinite(x))
  if (!strings || !numbers || !STATUSES.includes(r.status as LoopStatus)) return null
  const said = r.said && typeof r.said === 'object' && typeof r.said.seconds === 'number' && typeof r.said.note === 'string' ? { seconds: r.said.seconds, note: r.said.note } : undefined
  return {
    goal: r.goal!,
    until: r.until!,
    max_rounds: r.max_rounds!,
    deadline: r.deadline!,
    interval_s: r.interval_s!,
    status: r.status!,
    round: r.round!,
    since: r.since!,
    ...(typeof r.next_at === 'string' && r.next_at ? { next_at: r.next_at } : {}),
    ...(typeof r.note === 'string' ? { note: r.note } : {}),
    ...(typeof r.reason === 'string' && r.reason ? { reason: r.reason } : {}),
    ...(typeof r.turn === 'string' && r.turn ? { turn: r.turn } : {}),
    ...(said ? { said } : {}),
    ...(typeof r.stalled === 'number' ? { stalled: r.stalled } : {}),
    ...(typeof r.url === 'string' ? { url: r.url } : {}),
  }
}

export class LoopStore {
  private loops = new Map<string, LoopState>()
  /** 組んだ・進んだ・止めた・片付けたで進める（rev に混ぜる） */
  private version = 0
  readonly path: string | null

  /** path があればそこにも書き、起動時に読み戻す。null ならメモリだけ */
  constructor(path: string | null) {
    this.path = path
    this.load()
  }

  private load(): void {
    if (!this.path) return
    let raw: unknown
    try {
      raw = JSON.parse(readFileSync(this.path, 'utf-8'))
    } catch {
      return
    }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return
    for (const [id, value] of Object.entries(raw as Record<string, unknown>)) {
      const state = stateFrom(value)
      if (state) this.loops.set(id, state)
    }
  }

  /** いまの中身を書く。tmp → rename（replying.json と同じ）。書けなくてもメモリで続く */
  private persist(): void {
    this.version++
    if (!this.path) return
    try {
      mkdirSync(dirname(this.path), { recursive: true })
      const tmp = `${this.path}.${process.pid}.tmp`
      writeFileSync(tmp, JSON.stringify(Object.fromEntries(this.loops), null, 2) + '\n', { mode: 0o600 })
      renameSync(tmp, this.path)
    } catch {
      // 書けなくてもメモリで続く
    }
  }

  get(id: string): LoopState | undefined {
    return this.loops.get(id)
  }

  set(id: string, loop: LoopState): void {
    this.loops.set(id, loop)
    this.persist()
  }

  delete(id: string): boolean {
    if (!this.loops.delete(id)) return false
    this.persist()
    return true
  }

  /** 見に行く相手（回っているものと、一時停止のまま周のターンが残っているもの） */
  active(): [string, LoopState][] {
    return [...this.loops].filter(([, l]) => l.status === 'running' || (l.status === 'paused' && l.turn !== undefined))
  }

  /** 画面に出す形 */
  snapshot(): LoopMap {
    return Object.fromEntries([...this.loops].map(([id, l]) => [id, loopView(l)]))
  }

  key(): string {
    return String(this.version)
  }
}
