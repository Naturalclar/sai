// 処理中のターンが何をしているか（#302）。Claude の transcript と Codex の rollout の**末尾だけ**を読み、
// shared/progress.ts で手順にする。読むのは手元のファイルだけで、パスは行（セッション ID と cwd）とホーム / CODEX_HOME から
// 組み立てる（リクエストからは受け取らない。usage.ts / permissions.ts と同じ）。
//
// transcript は大きい（手元で 29.7MB、1 行の最大は 1MB = 画像の tool_result）。末尾から「ターンの始まり」までの距離は
// ターンによって違う（最新の assistant の行まで中央値 5KB、p99 170KB、最大 1.2MB）ので、64KB から倍々に読み足し、
// ターンの始まりが見えたか PROGRESS_TAIL_MAX に届いたところで止める
import { open, readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { claudeProgress, claudeProjectName, codexProgress, PROGRESS_STEPS, progressActive } from '../../shared/progress.ts'
import type { ParsedProgress } from '../../shared/progress.ts'
import type { SessionProgressResponse, SessionSummary } from '../../shared/types.ts'
import { CODEX_DAYS } from './usage.ts'

/** 最初に読む末尾の量 */
export const PROGRESS_TAIL_START = 64 * 1024
/** 読み足す上限。ここまで読んでもターンの始まりが無ければ、読めたぶんで組む（長いターンの途中から） */
export const PROGRESS_TAIL_MAX = 4 * 1024 * 1024
/** 見つからなかったセッションを探し直すまでの間（画面は 3 秒おきに聞いてくる） */
export const PROGRESS_MISS_MS = 60_000
/** セッション ID として受ける形。パスに混ぜるので `/` や `.` を通さない */
const SESSION_RE = /^[A-Za-z0-9][A-Za-z0-9_-]*$/

type Target = Pick<SessionSummary, 'id' | 'repo' | 'agent' | 'cwd'>

/** エンティティ ID（`<session>@<repo>`。`shared/entity.ts` の `entityId()`）からセッション ID。取れない行（`unknown-<日付>`）と、パスに混ぜられない形は空 */
export function sessionOf(s: Pick<SessionSummary, 'id' | 'repo'>): string {
  const session = s.repo && s.id.endsWith(`@${s.repo}`) ? s.id.slice(0, -(s.repo.length + 1)) : s.id
  return SESSION_RE.test(session) && !session.startsWith('unknown-') ? session : ''
}

const empty = (id: string): SessionProgressResponse => ({ rev: '', id, active: false, steps: [], total: 0, updated_at: '' })

async function names(dir: string): Promise<string[]> {
  try {
    return await readdir(dir)
  } catch {
    return []
  }
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile()
  } catch {
    return false
  }
}

async function readTail(path: string, size: number, bytes: number): Promise<string[]> {
  const fh = await open(path, 'r')
  try {
    const start = Math.max(0, size - bytes)
    const buf = Buffer.alloc(size - start)
    await fh.read(buf, 0, buf.length, start)
    const lines = buf.toString('utf-8').split('\n')
    // 先頭は行の途中から始まっている（ファイルの頭から読めたときだけ残す）
    if (start > 0) lines.shift()
    return lines
  } finally {
    await fh.close()
  }
}

/** 末尾から倍々に読み足して、ターンの始まりが見えたところで止める（見えなければ上限まで読んだぶんで組む） */
export async function parseTail(path: string, size: number, parse: (lines: readonly string[]) => ParsedProgress, max = PROGRESS_TAIL_MAX): Promise<ParsedProgress> {
  for (let bytes = PROGRESS_TAIL_START; ; bytes *= 2) {
    const parsed = parse(await readTail(path, size, Math.min(bytes, size)))
    if (parsed.started || bytes >= size || bytes >= max) return parsed
  }
}

export class ProgressReader {
  private readonly claudeProjects: string
  private readonly codexSessions: string
  private readonly now: () => number
  /** セッション → ファイルのパス（見つけたら覚える。消えていたら探し直す） */
  private readonly paths = new Map<string, string>()
  /** 見つからなかったセッション → 探した時刻 */
  private readonly misses = new Map<string, number>()
  /** ファイル → (mtime, size) が同じ間は組み直さない */
  private readonly parsed = new Map<string, { sig: string; value: ParsedProgress }>()

  constructor(claudeProjects: string, codexSessions: string, now: () => number = Date.now) {
    this.claudeProjects = claudeProjects
    this.codexSessions = codexSessions
    this.now = now
  }

  /** そのセッションの最後のターンの手順。Claude と Codex だけ（OpenCode は手元にファイルが無い）。読めなければ空 */
  async read(s: Target): Promise<SessionProgressResponse> {
    const session = sessionOf(s)
    if (!session || (s.agent !== 'claude' && s.agent !== 'codex')) return empty(s.id)
    const key = `${s.agent}:${session}`
    const path = await this.locate(key, s.agent, session, s.cwd)
    if (!path) return empty(s.id)
    try {
      const st = await stat(path)
      const sig = `${st.mtimeMs}:${st.size}`
      let cached = this.parsed.get(path)
      if (!cached || cached.sig !== sig) {
        cached = { sig, value: await parseTail(path, st.size, s.agent === 'claude' ? claudeProgress : codexProgress) }
        this.parsed.set(path, cached)
      }
      const { steps } = cached.value
      const active = progressActive(cached.value, st.mtimeMs, this.now())
      return { rev: `${sig}:${active ? 1 : 0}`, id: s.id, active, steps: steps.slice(-PROGRESS_STEPS), total: steps.length, updated_at: new Date(st.mtimeMs).toISOString() }
    } catch {
      // 消えた・読めない。次は探し直す
      this.paths.delete(key)
      this.parsed.delete(path)
      return empty(s.id)
    }
  }

  private async locate(key: string, agent: 'claude' | 'codex', session: string, cwd: string): Promise<string> {
    const known = this.paths.get(key)
    if (known) return known
    const missed = this.misses.get(key)
    if (missed !== undefined && this.now() - missed < PROGRESS_MISS_MS) return ''
    const found = agent === 'claude' ? await this.findClaude(session, cwd) : await this.findCodex(session)
    if (found) {
      this.paths.set(key, found)
      this.misses.delete(key)
    } else {
      this.misses.set(key, this.now())
    }
    return found
  }

  /** `<projects>/<cwd の記号を - にしたもの>/<session>.jsonl`。組み立てた名前に無ければ、projects の直下のディレクトリを 1 段だけ探す */
  private async findClaude(session: string, cwd: string): Promise<string> {
    const name = `${session}.jsonl`
    if (cwd) {
      const direct = join(this.claudeProjects, claudeProjectName(cwd), name)
      if (await isFile(direct)) return direct
    }
    for (const dir of await names(this.claudeProjects)) {
      const path = join(this.claudeProjects, dir, name)
      if (await isFile(path)) return path
    }
    return ''
  }

  /**
   * `<sessions>/YYYY/MM/DD/rollout-…-<session>.jsonl`。新しい日付から CODEX_DAYS 日ぶんだけ降りる
   * （使用量の `recentRollouts()` と同じ範囲。それより古い日に始めて開きっぱなしのセッションは引かない）
   */
  private async findCodex(session: string): Promise<string> {
    const desc = (list: string[]) => list.filter((n) => /^\d+$/.test(n)).sort((a, b) => b.localeCompare(a))
    let days = 0
    for (const year of desc(await names(this.codexSessions))) {
      for (const month of desc(await names(join(this.codexSessions, year)))) {
        for (const day of desc(await names(join(this.codexSessions, year, month)))) {
          if (days++ >= CODEX_DAYS) return ''
          const dir = join(this.codexSessions, year, month, day)
          const name = (await names(dir)).find((n) => n.startsWith('rollout-') && n.endsWith(`${session}.jsonl`))
          if (name) return join(dir, name)
        }
      }
    }
    return ''
  }
}
